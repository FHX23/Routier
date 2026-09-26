import fg from 'fast-glob';
import path from 'node:path';
import type { Endpoint, HttpMethod, JsonSchema, MethodMetadata } from '../../types.js';
import type { AdapterOptions, AdapterResult } from '../index.js';
import {
  findFunctionBody,
  findMatching,
  objectLiteralProps,
  parseImports,
  parseLiteralValue,
  parseStringLiteral,
  splitTopLevel,
} from '../shared/code.js';
import { AUTH_MIDDLEWARE, inferHandlerMetadata, normalizeRoutePath, routeParamsOf } from '../shared/handler.js';
import { SourceLoader } from '../shared/source.js';
import { exampleFromSchema, inferZodSchemaByName } from '../shared/zod.js';
import { SOURCE_GLOB, SOURCE_IGNORE } from '../express/index.js';

const VERBS: Record<string, HttpMethod[]> = {
  get: ['GET'],
  post: ['POST'],
  put: ['PUT'],
  patch: ['PATCH'],
  delete: ['DELETE'],
  head: ['HEAD'],
  options: ['OPTIONS'],
  all: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
};

interface Range {
  start: number;
  end: number;
}

interface Registration {
  position: number;
  methods: HttpMethod[];
  path: string;
  handlers: string[];
  schema?: string;
  auth: boolean;
}

interface PluginRegister {
  position: number;
  prefix: string;
  /** Plugin definido en línea o como función local: rango del archivo al que aplica el prefijo. */
  range?: Range;
  /** Plugin importado: archivos a los que aplica el prefijo. */
  targets: { file: string; prefix: string }[];
}

interface FileInfo {
  file: string;
  absolute: string;
  code: string;
  registrations: Registration[];
  registers: PluginRegister[];
  /** Ámbitos (rango o archivo completo) con un hook de autenticación (`addHook('onRequest', fastify.authenticate)`). */
  authScopes: Range[];
}

const HOOK_KEYS = ['onRequest', 'preHandler', 'preValidation', 'preParsing'];

function hookRequiresAuth(props: Map<string, string>): boolean {
  return HOOK_KEYS.some((key) => {
    const value = props.get(key);
    return value !== undefined && AUTH_MIDDLEWARE.test(value);
  });
}

function methodsFrom(value: string | undefined): HttpMethod[] {
  if (!value) return [];
  const parsed = parseLiteralValue(value);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.toUpperCase())
    .filter((item): item is HttpMethod => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(item));
}

async function analyseFile(file: string, absolute: string, code: string, loader: SourceLoader, cwd: string): Promise<FileInfo> {
  const info: FileInfo = { file, absolute, code, registrations: [], registers: [], authScopes: [] };
  const imports = parseImports(code);

  const call = /(?<![\w$.])([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|all|route|register|addHook)\s*\(/g;
  for (const match of code.matchAll(call)) {
    const verb = match[2];
    const open = match.index! + match[0].length - 1;
    const close = findMatching(code, open);
    if (close === -1) continue;
    const args = splitTopLevel(code.slice(open + 1, close));
    const position = match.index!;

    if (verb === 'addHook') {
      if (args.length >= 2 && HOOK_KEYS.includes(parseStringLiteral(args[0]) ?? '') && AUTH_MIDDLEWARE.test(args[1])) {
        const scope = innermostRange(info, position) ?? { start: 0, end: code.length };
        info.authScopes.push(scope);
      }
      continue;
    }

    if (verb === 'route') {
      const props = objectLiteralProps(args[0] ?? '');
      const url = parseStringLiteral(props.get('url') ?? props.get('path') ?? '');
      const methods = methodsFrom(props.get('method'));
      const handler = props.get('handler');
      if (url === null || methods.length === 0 || !handler) continue;
      const hooks = HOOK_KEYS.map((key) => props.get(key)).filter((value): value is string => Boolean(value));
      info.registrations.push({ position, methods, path: url, handlers: [...hooks, handler], schema: props.get('schema'), auth: hookRequiresAuth(props) });
      continue;
    }

    if (verb === 'register') {
      const pluginArg = args[0]?.trim();
      if (!pluginArg) continue;
      const opts = objectLiteralProps(args[1] ?? '{}');
      const prefix = parseStringLiteral(opts.get('prefix') ?? '') ?? '';
      const register: PluginRegister = { position, prefix, targets: [] };

      const importName = /^([\w$]+)$/.exec(pluginArg)?.[1];
      const dynamicImport = /^(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/.exec(pluginArg);
      const binding = importName ? imports.get(importName) : undefined;

      if (binding?.specifier === '@fastify/autoload' || binding?.specifier === 'fastify-autoload') {
        // Autoload recibe el prefijo en `options: { prefix }`.
        const autoloadPrefix = parseStringLiteral(objectLiteralProps(opts.get('options') ?? '{}').get('prefix') ?? '') ?? '';
        register.targets.push(...(await autoloadTargets(opts, absolute, cwd, normalizeRoutePath(prefix, autoloadPrefix))));
        register.prefix = '';
      } else if (/^(async\b|function\b|\()/.test(pluginArg)) {
        const argStart = code.indexOf(pluginArg, open);
        register.range = { start: argStart, end: argStart + pluginArg.length };
      } else if (importName && findFunctionBody(code, importName)) {
        const body = findFunctionBody(code, importName)!;
        const start = code.indexOf(body);
        register.range = { start, end: start + body.length };
      } else {
        const specifier = dynamicImport?.[2] ?? binding?.specifier;
        const target = specifier ? loader.resolve(absolute, specifier) : null;
        if (target) register.targets.push({ file: path.relative(cwd, target).replace(/\\/g, '/'), prefix: '' });
      }
      info.registers.push(register);
      continue;
    }

    // fastify.get('/x', [opts,] handler)
    if (args.length < 2) continue;
    const routePath = parseStringLiteral(args[0]);
    if (routePath === null || !(routePath.startsWith('/') || routePath === '')) continue;
    const props = args.length >= 3 ? objectLiteralProps(args[1]) : new Map<string, string>();
    const hooks = HOOK_KEYS.map((key) => props.get(key)).filter((value): value is string => Boolean(value));
    const handler = args.length >= 3 ? args[args.length - 1] : args[1];
    // `fastify.get('/x', { handler })` sin handler posicional
    const finalHandler = objectLiteralProps(handler).get('handler') ?? handler;
    const handlerProps = objectLiteralProps(handler);
    info.registrations.push({
      position,
      methods: VERBS[verb],
      path: routePath,
      handlers: [...hooks, finalHandler],
      schema: props.get('schema') ?? handlerProps.get('schema'),
      auth: hookRequiresAuth(props) || hookRequiresAuth(handlerProps),
    });
  }

  return info;
}

function innermostRange(info: FileInfo, position: number): Range | undefined {
  return info.registers
    .map((register) => register.range)
    .filter((range): range is Range => Boolean(range) && range!.start <= position && position <= range!.end)
    .sort((a, b) => (b.start - a.start))[0];
}

/** `@fastify/autoload`: cada archivo de `dir` se registra con el prefijo de su carpeta. */
async function autoloadTargets(opts: Map<string, string>, absolute: string, cwd: string, prefix: string) {
  const dirExpression = opts.get('dir') ?? '';
  const literals = [...dirExpression.matchAll(/(['"`])([^'"`]+)\1/g)].map((match) => match[2]);
  if (literals.length === 0) return [];
  const dir = path.resolve(path.dirname(absolute), ...literals);
  const routeParams = opts.get('routeParams') === 'true';

  const files = await fg([SOURCE_GLOB], { cwd: dir, ignore: SOURCE_IGNORE });
  return files.map((file) => {
    const folders = path.posix.dirname(file).split('/').filter((segment) => segment && segment !== '.');
    const segments = folders.map((segment) => (routeParams && segment.startsWith('_') ? `:${segment.slice(1)}` : segment));
    return {
      file: path.relative(cwd, path.join(dir, file)).replace(/\\/g, '/'),
      prefix: normalizeRoutePath(prefix, ...segments),
    };
  });
}

/** Devuelve el texto del objeto literal asignado a `name` (`const x = {...} as const`), o `null`. */
function objectLiteralOf(code: string, name: string): string | null {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*\\{`).exec(code);
  if (!declaration) return null;
  const open = declaration.index + declaration[0].length - 1;
  const close = findMatching(code, open);
  return close === -1 ? null : code.slice(open, close + 1);
}

/** Convierte `schema: { body, querystring, headers }` (JSON Schema literal o schema Zod) en metadatos. */
async function metadataFromSchema(schemaText: string | undefined, info: FileInfo, loader: SourceLoader): Promise<MethodMetadata> {
  const meta: MethodMetadata = {};
  if (!schemaText) return meta;

  const resolve = (value: string) => (/^[\w$]+$/.test(value.trim()) ? objectLiteralOf(info.code, value.trim()) ?? value : value);
  const text = resolve(schemaText);

  const props = objectLiteralProps(text);
  const bodyText = props.get('body');
  if (bodyText) {
    let schema: JsonSchema | null = null;
    const literal = parseLiteralValue(resolve(bodyText));
    if (literal && typeof literal === 'object') {
      schema = literal as JsonSchema;
    } else if (/^[\w$]+$/.test(bodyText)) {
      schema = (await inferZodSchemaByName(bodyText, info.absolute, loader))?.schema ?? null;
    }
    if (schema) {
      meta.bodySchema = schema;
      meta.body = JSON.stringify(exampleFromSchema(schema), null, 2);
    }
  }

  const keysOf = (value: string | undefined) => {
    const literal = value ? parseLiteralValue(resolve(value)) : undefined;
    const properties = literal && typeof literal === 'object' ? (literal as JsonSchema).properties : undefined;
    return properties ? Object.keys(properties) : [];
  };
  const query = keysOf(props.get('querystring') ?? props.get('query'));
  if (query.length > 0) meta.query = query;
  const headers = keysOf(props.get('headers')).map((name) => (name.toLowerCase() === 'authorization' ? 'Authorization' : name));
  if (headers.length > 0) meta.headers = headers;

  return meta;
}

function mergeMetadata(base: MethodMetadata | undefined, extra: MethodMetadata): MethodMetadata | undefined {
  const merged: MethodMetadata = { ...base };
  const union = (a: string[] = [], b: string[] = []) => {
    const result = [...a];
    for (const item of b) if (!result.some((value) => value.toLowerCase() === item.toLowerCase())) result.push(item);
    return result;
  };
  const headers = union(base?.headers, extra.headers);
  const query = union(base?.query, extra.query);
  if (headers.length > 0) merged.headers = headers;
  if (query.length > 0) merged.query = query;
  if (extra.body) {
    merged.body = extra.body;
    merged.bodySchema = extra.bodySchema;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function scanFastifyRoutes(options: AdapterOptions): Promise<AdapterResult> {
  const cwd = path.resolve(options.cwd);
  const loader = new SourceLoader(cwd);
  const files = new Map<string, FileInfo>();

  const sourceFiles = await fg([SOURCE_GLOB], { cwd, ignore: [...SOURCE_IGNORE, ...(options.exclude ?? [])] });
  for (const file of sourceFiles) {
    const absolute = path.join(cwd, file);
    const code = await loader.load(absolute);
    if (!code || !/\bfastify\b|FastifyInstance|FastifyPlugin/i.test(code)) continue;
    const info = await analyseFile(file, absolute, code, loader, cwd);
    if (info.registrations.length > 0 || info.registers.length > 0) files.set(file, info);
  }

  // Prefijo local: suma de los plugins en línea que envuelven la posición.
  const localPrefix = (info: FileInfo, position: number) => info.registers
    .filter((register) => register.range && register.range.start <= position && position <= register.range.end)
    .sort((a, b) => a.range!.start - b.range!.start)
    .map((register) => register.prefix);

  const parentsOf = new Map<string, { from: FileInfo; register: PluginRegister; prefix: string }[]>();
  for (const info of files.values()) {
    for (const register of info.registers) {
      for (const target of register.targets) {
        parentsOf.set(target.file, [...(parentsOf.get(target.file) ?? []), { from: info, register, prefix: target.prefix }]);
      }
    }
  }

  const memo = new Map<string, string[]>();
  const filePrefixes = (file: string, trail: Set<string> = new Set()): string[] => {
    if (memo.has(file)) return memo.get(file)!;
    const parents = parentsOf.get(file);
    if (!parents || trail.has(file)) return [''];
    const nextTrail = new Set(trail).add(file);
    const prefixes = parents.flatMap(({ from, register, prefix }) =>
      filePrefixes(from.file, nextTrail).map((base) =>
        normalizeRoutePath(base, ...localPrefix(from, register.position), register.prefix, prefix),
      ),
    );
    memo.set(file, prefixes);
    return prefixes;
  };

  const endpoints = new Map<string, Endpoint>();
  for (const info of files.values()) {
    for (const registration of info.registrations) {
      const scopedAuth = info.authScopes.some((scope) => scope.start <= registration.position && registration.position <= scope.end);
      const schemaMeta = await metadataFromSchema(registration.schema, info, loader);

      for (const base of filePrefixes(info.file)) {
        const routePath = normalizeRoutePath(base, ...localPrefix(info, registration.position), registration.path);
        const key = `${routePath} ${info.file}`;
        const endpoint = endpoints.get(key) ?? { path: routePath, methods: [], fileType: 'rest' as const, sourceFile: info.file, router: 'fastify' as const };
        endpoints.set(key, endpoint);

        for (const method of registration.methods) {
          if (endpoint.methods.includes(method)) continue;
          endpoint.methods.push(method);
          const inferred = await inferHandlerMetadata({
            filePath: info.absolute,
            loader,
            method,
            handlers: registration.handlers,
            routeParams: routeParamsOf(routePath),
            requiresAuth: registration.auth || scopedAuth,
          });
          const meta = mergeMetadata(inferred, ['POST', 'PUT', 'PATCH'].includes(method) ? schemaMeta : { ...schemaMeta, body: undefined, bodySchema: undefined });
          if (meta) endpoint.methodsMetadata = { ...endpoint.methodsMetadata, [method]: meta };
        }
      }
    }
  }

  return { endpoints: [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path)), warnings: [] };
}

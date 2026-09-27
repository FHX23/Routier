import fg from 'fast-glob';
import path from 'node:path';
import type { AuthRequirement, Endpoint, HttpMethod, MethodMetadata } from '../../types.js';
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
import { AUTH_MIDDLEWARE, inferHandlerMetadata, isAuthMiddleware, normalizeRoutePath, routeParamsOf } from '../shared/handler.js';
import { SourceLoader } from '../shared/source.js';
import { AuthDetector } from '../shared/auth.js';
import { applyBody } from '../shared/metadata.js';
import { interpretValidatorObject, resolveExpression } from '../shared/schemas.js';
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

interface AuthScope {
  range: Range;
  auth: AuthRequirement;
  /** Rutas exceptuadas dentro del hook (`if (request.url.startsWith('/api/auth/login')) return`). */
  exempt: string[];
}

/** Hooks de un archivo `autohooks` de @fastify/autoload: aplican a su carpeta (y subcarpetas con cascadeHooks). */
interface DirectoryHooks {
  dir: string;
  cascade: boolean;
  file: string;
}

interface FileInfo {
  file: string;
  absolute: string;
  code: string;
  registrations: Registration[];
  registers: PluginRegister[];
  /** Ámbitos (rango o archivo completo) con un hook de autenticación (`addHook('onRequest', fastify.authenticate)`). */
  authScopes: AuthScope[];
}

const HOOK_KEYS = ['onRequest', 'preHandler', 'preValidation', 'preParsing'];

function hookRequiresAuth(props: Map<string, string>): boolean {
  return HOOK_KEYS.some((key) => {
    const value = props.get(key);
    return value !== undefined && isAuthMiddleware(value);
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

async function analyseFile(
  file: string,
  absolute: string,
  code: string,
  loader: SourceLoader,
  cwd: string,
  sessionCookie: () => Promise<string>,
  directoryHooks: DirectoryHooks[],
): Promise<FileInfo> {
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
      const hook = args[1] ?? '';
      const isSession = /\b(?:req|request)\s*\.\s*session\b/.test(hook);
      if (args.length >= 2 && HOOK_KEYS.includes(parseStringLiteral(args[0]) ?? '') && (AUTH_MIDDLEWARE.test(hook) || isSession)) {
        const range = innermostRange(info, position) ?? { start: 0, end: code.length };
        const auth: AuthRequirement = isSession ? { type: 'session', cookie: await sessionCookie() } : { type: 'bearer' };
        const exempt = [...hook.matchAll(/(['"`])(\/[^'"`\s]*)\1/g)].map((m) => m[2]);
        info.authScopes.push({ range, auth, exempt });
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
        const loaded = await autoloadTargets(opts, absolute, cwd, normalizeRoutePath(prefix, autoloadPrefix));
        register.targets.push(...loaded.targets);
        directoryHooks.push(...loaded.hooks);
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
  if (literals.length === 0) return { targets: [], hooks: [] };
  const dir = path.resolve(path.dirname(absolute), ...literals);
  const routeParams = opts.get('routeParams') === 'true';

  const autoHooks = opts.get('autoHooks') === 'true';
  const cascade = opts.get('cascadeHooks') === 'true';
  const files = await fg([SOURCE_GLOB], { cwd: dir, ignore: SOURCE_IGNORE });
  const relative = (file: string) => path.relative(cwd, path.join(dir, file)).replace(/\\/g, '/');
  const isHooks = (file: string) => /(^|\/)autohooks\.[mc]?[jt]s$/.test(file);

  const hooks: DirectoryHooks[] = autoHooks
    ? files.filter(isHooks).map((file) => ({ file: relative(file), dir: path.posix.dirname(relative(file)), cascade }))
    : [];
  const targets = files.filter((file) => !(autoHooks && isHooks(file))).map((file) => {
    const folders = path.posix.dirname(file).split('/').filter((segment) => segment && segment !== '.');
    const segments = folders.map((segment) => (routeParams && segment.startsWith('_') ? `:${segment.slice(1)}` : segment));
    return { file: relative(file), prefix: normalizeRoutePath(prefix, ...segments) };
  });
  return { targets, hooks };
}

/** Convierte `schema: { body, querystring, headers, consumes }` (JSON Schema, TypeBox, Zod o Joi) en metadatos. */
async function metadataFromSchema(schemaText: string | undefined, info: FileInfo, loader: SourceLoader): Promise<MethodMetadata> {
  const meta: MethodMetadata = {};
  if (!schemaText) return meta;

  const validator = await interpretValidatorObject(schemaText, info.absolute, loader);
  const resolved = await resolveExpression(schemaText, info.absolute, loader);
  const multipart = /multipart\/form-data/.test(resolved?.text ?? '');
  if (validator?.body || multipart) {
    applyBody(meta, {
      contentType: multipart ? 'multipart/form-data' : 'application/json',
      schema: validator?.body ?? { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
    });
  }
  if (validator?.query?.length) meta.query = validator.query;
  const headers = (validator?.headers ?? []).map((name) => (name.toLowerCase() === 'authorization' ? 'Authorization' : name));
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
  if (extra.bodySchema || extra.bodyContentType) {
    merged.body = extra.body;
    merged.bodySchema = extra.bodySchema;
    merged.bodyContentType = extra.bodyContentType;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function scanFastifyRoutes(options: AdapterOptions): Promise<AdapterResult> {
  const cwd = path.resolve(options.cwd);
  const loader = new SourceLoader(cwd);
  const authDetector = new AuthDetector(cwd, loader);
  const sessionCookie = () => authDetector.cookieFor('node-session');
  const directoryHooks: DirectoryHooks[] = [];
  const hookScopes = new Map<string, AuthScope[]>();
  const files = new Map<string, FileInfo>();

  const sourceFiles = await fg([SOURCE_GLOB], { cwd, ignore: [...SOURCE_IGNORE, ...(options.exclude ?? [])] });
  for (const file of sourceFiles) {
    const absolute = path.join(cwd, file);
    const code = await loader.load(absolute);
    if (!code || !/\bfastify\b|FastifyInstance|FastifyPlugin/i.test(code)) continue;
    const info = await analyseFile(file, absolute, code, loader, cwd, sessionCookie, directoryHooks);
    if (info.registrations.length > 0 || info.registers.length > 0) files.set(file, info);
    if (info.authScopes.length > 0) hookScopes.set(file, info.authScopes);
  }

  /** Auth heredada de los archivos autohooks de las carpetas que contienen a `file`. */
  const directoryAuth = (file: string, routePath: string): AuthRequirement | undefined => {
    for (const hooks of directoryHooks) {
      const inside = hooks.cascade ? file.startsWith(`${hooks.dir}/`) : path.posix.dirname(file) === hooks.dir;
      if (!inside) continue;
      for (const scope of hookScopes.get(hooks.file) ?? []) {
        if (scope.exempt.some((prefix) => routePath.startsWith(prefix))) continue;
        return scope.auth;
      }
    }
    return undefined;
  };

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
      const scoped = info.authScopes.find((scope) => scope.range.start <= registration.position && registration.position <= scope.range.end);
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
            inheritedAuth: registration.auth
              ? { type: 'bearer' }
              : scoped && !scoped.exempt.some((prefix) => routePath.startsWith(prefix)) ? scoped.auth : directoryAuth(info.file, routePath),
            authDetector,
          });
          const meta = mergeMetadata(inferred, ['POST', 'PUT', 'PATCH'].includes(method) ? schemaMeta : { ...schemaMeta, body: undefined, bodySchema: undefined, bodyContentType: undefined });
          if (meta) endpoint.methodsMetadata = { ...endpoint.methodsMetadata, [method]: meta };
        }
      }
    }
  }

  return { endpoints: [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path)), warnings: [] };
}

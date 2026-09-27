import fg from 'fast-glob';
import path from 'node:path';
import type { Endpoint, HttpMethod, JsonSchema, MethodMetadata } from '../../types.js';
import type { AdapterOptions, AdapterResult } from '../index.js';
import { findMatching, objectLiteralProps, parseLiteralValue, parseStringLiteral, splitTopLevel } from '../shared/code.js';
import {
  type ClassMember,
  type Decorator,
  findDecoratedClasses,
  readDecorators,
  scanClassMembers,
  typeTextToSchema,
} from '../shared/classes.js';
import { isAuthMiddleware, normalizeRoutePath, routeParamsOf } from '../shared/handler.js';
import { inferTrackedQuery, trackValue } from '../shared/flow.js';
import { applyBody } from '../shared/metadata.js';
import { inferHeaders, inferQueryParams } from '../shared/request.js';
import { SourceLoader } from '../shared/source.js';
import { inferZodBody, resolveSchemaByName } from '../shared/zod.js';
import { SOURCE_IGNORE } from '../express/index.js';

const HTTP_DECORATORS: Record<string, HttpMethod[]> = {
  Get: ['GET'],
  Post: ['POST'],
  Put: ['PUT'],
  Patch: ['PATCH'],
  Delete: ['DELETE'],
  Head: ['HEAD'],
  Options: ['OPTIONS'],
  All: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
};

const BODY_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH'];
const AUTH_GUARD = /auth|jwt|guard|passport|session|bearer/i;
const PUBLIC_DECORATORS = new Set(['Public', 'SkipAuth', 'AllowAnonymous', 'IsPublic', 'NoAuth']);

interface MiddlewareRule {
  /** Ruta relativa (sin prefijo global) o `null` si la regla es un controlador completo. */
  path: RegExp | null;
  controller: string | null;
  method: HttpMethod | 'ALL';
}

interface AppSettings {
  globalPrefix: string;
  /** Rutas excluidas del prefijo global (`setGlobalPrefix('api', { exclude: ['/'] })`). */
  prefixExclude: string[];
  /** Middlewares de auth aplicados con `consumer.apply(AuthMiddleware).forRoutes(...)`. */
  authRules: MiddlewareRule[];
  /** Prefijo de versión por URI (`v`) o `null` si el versionado por URI no está activo. */
  versionPrefix: string | null;
  defaultVersion: string | null;
  graphqlPath: string | null;
  graphqlSource: string;
}

/** Lee `setGlobalPrefix`, `enableVersioning` y `GraphQLModule.forRoot` en todo el proyecto. */
/** Valor por defecto de una clave de configuración: `apiPrefix: process.env.API_PREFIX || 'api'`. */
function configDefault(key: string, configSources: string[]): string | null {
  const escaped = key.replace(/[$.]/g, '\\$&');
  const pattern = new RegExp(`\\b${escaped}\\s*:\\s*process\\.env\\.[\\w$]+\\s*(?:\\|\\||\\?\\?)\\s*(['"\`])([^'"\`]*)\\1`);
  for (const code of configSources) {
    const match = pattern.exec(code);
    if (match) return match[2];
  }
  return null;
}

/** Resuelve el argumento de setGlobalPrefix: literal, `process.env.X || 'api'` o `config.get('app.apiPrefix')`. */
function resolvePrefix(arg: string, configSources: string[]): string | null {
  const literal = parseStringLiteral(arg);
  if (literal !== null) return literal;
  const fallback = /(?:\|\||\?\?)\s*(['"`])([^'"`]*)\1\s*$/.exec(arg);
  if (fallback) return fallback[2];
  const configKey = /\(\s*(['"`])([^'"`]+)\1/.exec(arg);
  if (configKey) return configDefault(configKey[2].split('.').pop()!, configSources);
  return null;
}

const REQUEST_METHODS: Record<string, HttpMethod | 'ALL'> = {
  GET: 'GET', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', DELETE: 'DELETE', HEAD: 'HEAD', OPTIONS: 'OPTIONS', ALL: 'ALL',
};

function routeRegex(pattern: string): RegExp {
  const normalized = normalizeRoutePath(pattern.replace(/\(\.\*\)|\*/g, '__WILDCARD__'));
  const source = normalized
    .split('__WILDCARD__')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[\w$]+/g, '[^/]+'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** `consumer.apply(AuthMiddleware).forRoutes({ path: 'user', method: RequestMethod.GET }, UsersController)`. */
function readMiddlewareRules(code: string): MiddlewareRule[] {
  const rules: MiddlewareRule[] = [];
  for (const match of code.matchAll(/\.\s*apply\s*\(([^)]*)\)[\s\S]{0,200}?\.\s*forRoutes\s*\(/g)) {
    if (!isAuthMiddleware(match[1])) continue;
    const open = match.index! + match[0].length - 1;
    const close = findMatching(code, open);
    if (close === -1) continue;
    for (const arg of splitTopLevel(code.slice(open + 1, close))) {
      const text = arg.trim();
      const literal = parseStringLiteral(text);
      if (literal !== null) {
        rules.push({ path: routeRegex(literal), controller: null, method: 'ALL' });
      } else if (text.startsWith('{')) {
        const props = objectLiteralProps(text);
        const routePath = parseStringLiteral(props.get('path') ?? '');
        const method = /RequestMethod\s*\.\s*([A-Z]+)/.exec(props.get('method') ?? '')?.[1] ?? 'ALL';
        if (routePath !== null) rules.push({ path: routeRegex(routePath), controller: null, method: REQUEST_METHODS[method] ?? 'ALL' });
      } else if (/^[\w$]+$/.test(text)) {
        rules.push({ path: null, controller: text, method: 'ALL' });
      }
    }
  }
  return rules;
}

function readAppSettings(sources: { file: string; code: string }[], configSources: string[]): AppSettings {
  const settings: AppSettings = {
    globalPrefix: '', prefixExclude: [], authRules: [], versionPrefix: null, defaultVersion: null, graphqlPath: null, graphqlSource: '',
  };

  for (const { file, code } of sources) {
    const prefixCall = /setGlobalPrefix\s*\(/.exec(code);
    if (prefixCall) {
      const open = prefixCall.index + prefixCall[0].length - 1;
      const [arg, options] = splitTopLevel(code.slice(open + 1, findMatching(code, open)));
      const prefix = arg ? resolvePrefix(arg.trim(), configSources) : null;
      if (prefix !== null) settings.globalPrefix = prefix;
      const exclude = objectLiteralProps(options?.trim() ?? '{}').get('exclude');
      if (exclude) {
        settings.prefixExclude = [...exclude.matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => normalizeRoutePath(m[2]));
      }
    }
    settings.authRules.push(...readMiddlewareRules(code));

    const versioning = /enableVersioning\s*\(\s*(\{[\s\S]*?\})\s*\)/.exec(code);
    if (versioning && /VersioningType\s*\.\s*URI/.test(versioning[1])) {
      const props = objectLiteralProps(versioning[1]);
      const customPrefix = props.get('prefix');
      settings.versionPrefix = customPrefix === 'false' ? '' : parseStringLiteral(customPrefix ?? '') ?? 'v';
      const defaultVersion = parseLiteralValue(props.get('defaultVersion') ?? '');
      if (typeof defaultVersion === 'string' || typeof defaultVersion === 'number') settings.defaultVersion = String(defaultVersion);
    }

    if (/GraphQLModule\s*\.\s*forRoot(?:Async)?\s*[<(]/.test(code)) {
      const graphqlPath = /GraphQLModule[\s\S]*?\bpath\s*:\s*(['"`])([^'"`]+)\1/.exec(code);
      settings.graphqlPath = graphqlPath?.[2] ?? '/graphql';
      settings.graphqlSource = file;
    }
  }
  return settings;
}

function pathsFromDecorator(args: string): string[] {
  const first = splitTopLevel(args)[0]?.trim();
  if (!first) return [''];
  const literal = parseLiteralValue(first);
  if (typeof literal === 'string') return [literal];
  if (Array.isArray(literal)) return literal.filter((item): item is string => typeof item === 'string');
  if (first.startsWith('{')) {
    const props = objectLiteralProps(first);
    const value = parseLiteralValue(props.get('path') ?? "''");
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  }
  return [''];
}

function versionFromDecorators(decorators: Decorator[], controllerArgs?: string): string | null {
  const version = decorators.find((decorator) => decorator.name === 'Version');
  if (version) {
    if (version.args.includes('VERSION_NEUTRAL')) return 'VERSION_NEUTRAL';
    const value = parseLiteralValue(splitTopLevel(version.args)[0] ?? '');
    return Array.isArray(value) ? String(value[0]) : value !== undefined ? String(value) : null;
  }
  const first = controllerArgs ? splitTopLevel(controllerArgs)[0]?.trim() : undefined;
  if (first?.startsWith('{')) {
    const raw = objectLiteralProps(first).get('version') ?? '';
    if (raw.includes('VERSION_NEUTRAL')) return 'VERSION_NEUTRAL';
    const value = parseLiteralValue(raw);
    if (Array.isArray(value)) return String(value[0]);
    if (value !== undefined) return String(value);
  }
  return null;
}

function requiresAuth(decorators: Decorator[], swaggerCounts = true): boolean | null {
  if (decorators.some((decorator) => PUBLIC_DECORATORS.has(decorator.name))) return false;
  if (swaggerCounts && decorators.some((decorator) => decorator.name === 'ApiBearerAuth')) return true;
  if (decorators.some((decorator) => ['UseGuards', 'Auth', 'Authorized', 'Roles'].includes(decorator.name) && (decorator.name !== 'UseGuards' || AUTH_GUARD.test(decorator.args)))) return true;
  return null;
}

interface Param {
  decorators: Decorator[];
  name: string;
  type?: string;
}

function parseParams(params: string): Param[] {
  return splitTopLevel(params).map((raw) => {
    const { decorators, end } = readDecorators(raw, 0);
    const rest = raw.slice(end).replace(/^(?:(?:public|private|protected|readonly)\s+)+/, '');
    const match = /^([\w$]+)\??\s*(?::\s*([\s\S]+?))?(?:=[\s\S]*)?$/.exec(rest.trim());
    return { decorators, name: match?.[1] ?? '', type: match?.[2]?.trim() };
  });
}

/** Schema Zod pasado a un pipe: `new ZodValidationPipe(createUserSchema)`. */
function zodPipeSchemaName(text: string): string | null {
  return /ZodValidationPipe\s*\(\s*([\w$]+)\s*\)/.exec(text)?.[1] ?? null;
}

async function inferMethodMetadata(
  member: ClassMember,
  method: HttpMethod,
  routePath: string,
  auth: boolean,
  filePath: string,
  loader: SourceLoader,
): Promise<MethodMetadata | undefined> {
  const headers: string[] = auth ? ['Authorization'] : [];
  const query: string[] = [];
  const routeParams = routeParamsOf(routePath);
  const ctx = { filePath, loader, depth: 0 };
  let bodySchema: JsonSchema | null = null;
  const bodyFields: Record<string, JsonSchema> = {};

  const addHeader = (name: string) => {
    const canonical = name.toLowerCase() === 'authorization' ? 'Authorization' : name;
    if (!headers.some((header) => header.toLowerCase() === canonical.toLowerCase())) headers.push(canonical);
  };
  const addQuery = (name: string) => {
    if (!routeParams.has(name) && !query.includes(name)) query.push(name);
  };

  for (const param of parseParams(member.params ?? '')) {
    for (const decorator of param.decorators) {
      const key = splitTopLevel(decorator.args).map(parseStringLiteral).find((value): value is string => value !== null);

      if (decorator.name === 'Headers' && key) addHeader(key);

      if (decorator.name === 'Query') {
        if (key) addQuery(key);
        else {
          const typed = param.type ? Object.keys((await typeTextToSchema(param.type, ctx)).schema.properties ?? {}) : [];
          typed.forEach(addQuery);
          // `@Query() query` sin tipo útil: seguir el objeto hasta el servicio (`this.service.findAll(query)`).
          if (typed.length === 0 && param.name && member.body) {
            (await inferTrackedQuery(member.body, [{ expr: param.name, path: [] }], { filePath, loader })).forEach(addQuery);
          }
        }
      }

      if (decorator.name === 'Body' && BODY_METHODS.includes(method)) {
        const pipeSchema = zodPipeSchemaName(decorator.args);
        if (pipeSchema) {
          bodySchema = await resolveSchemaByName(pipeSchema, filePath, loader);
        } else if (key) {
          bodyFields[key] = param.type ? (await typeTextToSchema(param.type, ctx)).schema : {};
          if (!bodyFields[key].type && param.name && member.body) {
            const tracked = await trackValue(member.body, [{ expr: param.name, path: [] }], { filePath, loader });
            if (tracked) bodyFields[key] = tracked.schema;
          }
        } else {
          const schema = param.type ? (await typeTextToSchema(param.type, ctx)).schema : {};
          if (schema.properties || schema.type) bodySchema = schema;
          else if (param.name && member.body) {
            // `@Body() body` sin tipo: campos leídos en el método o en los servicios que lo reciben.
            const tracked = await trackValue(member.body, [{ expr: param.name, path: [] }], { filePath, loader });
            if (tracked) bodySchema = tracked.schema;
          }
        }
      }
    }
  }

  const pipes = member.decorators.find((decorator) => decorator.name === 'UsePipes');
  const pipeName = pipes ? zodPipeSchemaName(pipes.args) : null;
  if (!bodySchema && pipeName && BODY_METHODS.includes(method)) {
    bodySchema = await resolveSchemaByName(pipeName, filePath, loader);
  }
  if (!bodySchema && Object.keys(bodyFields).length > 0) {
    bodySchema = { type: 'object', properties: bodyFields, required: Object.keys(bodyFields) };
  }

  if (member.body) {
    inferHeaders(member.body).forEach(addHeader);
    inferQueryParams(member.body).forEach(addQuery);
    if (!bodySchema && BODY_METHODS.includes(method)) {
      bodySchema = (await inferZodBody(member.body, filePath, loader))?.schema ?? null;
    }
  }

  // @UseInterceptors(FileInterceptor('file')) + @UploadedFile(): multipart
  const interceptors = member.decorators.filter((decorator) => decorator.name === 'UseInterceptors').map((decorator) => decorator.args).join(' ');
  const uploads = [...interceptors.matchAll(/(File|Files|AnyFiles|FileFields)Interceptor\s*\(\s*(?:(['"`])([\w.-]+)\2)?/g)];

  const meta: MethodMetadata = {};
  if (auth) meta.auth = { type: 'bearer' };
  if (headers.length > 0) meta.headers = headers;
  if (query.length > 0) meta.query = query;
  if (BODY_METHODS.includes(method) && uploads.length > 0) {
    const binary: JsonSchema = { type: 'string', format: 'binary' };
    const files = Object.fromEntries(uploads.map((match) => [match[3] ?? 'file', match[1] === 'Files' ? ({ type: 'array', items: binary } as JsonSchema) : binary]));
    applyBody(meta, { contentType: 'multipart/form-data', schema: { type: 'object', properties: { ...bodySchema?.properties, ...files } } });
  } else if (bodySchema) {
    applyBody(meta, { contentType: 'application/json', schema: bodySchema });
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export async function scanNestRoutes(options: AdapterOptions): Promise<AdapterResult> {
  const cwd = path.resolve(options.cwd);
  const loader = new SourceLoader(cwd);
  const files = await fg(['**/*.{ts,mts,js}'], { cwd, ignore: [...SOURCE_IGNORE, ...(options.exclude ?? [])] });

  const sources: { file: string; absolute: string; code: string }[] = [];
  const configSources: string[] = [];
  for (const file of files) {
    const absolute = path.join(cwd, file);
    const code = await loader.load(absolute);
    if (!code) continue;
    if (/@Controller\s*\(|setGlobalPrefix|enableVersioning|GraphQLModule|forRoutes/.test(code)) sources.push({ file, absolute, code });
    if (/process\.env/.test(code)) configSources.push(code);
  }

  const settings = readAppSettings(sources, configSources);
  const hasMiddlewareAuth = settings.authRules.length > 0;
  const matchesRule = (relativePath: string, method: HttpMethod, controller: string) => settings.authRules.some((rule) =>
    (rule.controller ? rule.controller === controller : rule.path!.test(relativePath)) && (rule.method === 'ALL' || rule.method === method));
  const endpoints = new Map<string, Endpoint>();

  for (const source of sources) {
    for (const controller of findDecoratedClasses(source.code, 'Controller')) {
      const controllerDecorator = controller.decorators.find((decorator) => decorator.name === 'Controller')!;
      const controllerPaths = pathsFromDecorator(controllerDecorator.args);
      // Con middlewares de auth por rutas, @ApiBearerAuth es solo documentación de Swagger.
      const controllerAuth = requiresAuth(controller.decorators, !hasMiddlewareAuth) ?? false;
      const controllerVersion = versionFromDecorators(controller.decorators, controllerDecorator.args);

      for (const member of scanClassMembers(controller.body)) {
        if (member.kind !== 'method') continue;
        const httpDecorator = member.decorators.find((decorator) => HTTP_DECORATORS[decorator.name]);
        if (!httpDecorator) continue;

        const methods = HTTP_DECORATORS[httpDecorator.name];
        const methodAuth = requiresAuth(member.decorators, !hasMiddlewareAuth);
        const version = versionFromDecorators(member.decorators) ?? controllerVersion ?? settings.defaultVersion;
        const versionSegment = settings.versionPrefix !== null && version && version !== 'VERSION_NEUTRAL'
          ? `${settings.versionPrefix}${version}`
          : '';

        for (const controllerPath of controllerPaths) {
          for (const methodPath of pathsFromDecorator(httpDecorator.args)) {
            const relativePath = normalizeRoutePath(controllerPath, methodPath);
            const excluded = settings.prefixExclude.includes(relativePath);
            const routePath = excluded
              ? relativePath
              : normalizeRoutePath(settings.globalPrefix, versionSegment, controllerPath, methodPath);
            const key = `${routePath} ${source.file}`;
            const endpoint = endpoints.get(key) ?? { path: routePath, methods: [], fileType: 'rest' as const, sourceFile: source.file, router: 'nestjs' as const };
            endpoints.set(key, endpoint);

            for (const method of methods) {
              if (endpoint.methods.includes(method)) continue;
              endpoint.methods.push(method);
              const auth = methodAuth ?? (controllerAuth || (hasMiddlewareAuth && matchesRule(normalizeRoutePath(versionSegment, relativePath), method, controller.name)) || (hasMiddlewareAuth && matchesRule(relativePath, method, controller.name)));
              const meta = await inferMethodMetadata(member, method, routePath, auth, source.absolute, loader);
              if (meta) endpoint.methodsMetadata = { ...endpoint.methodsMetadata, [method]: meta };
            }
          }
        }
      }
    }
  }

  const result = [...endpoints.values()];
  if (settings.graphqlPath) {
    result.push({
      path: normalizeRoutePath(settings.graphqlPath),
      methods: ['POST'],
      fileType: 'graphql',
      sourceFile: settings.graphqlSource,
      router: 'nestjs',
    });
  }

  return { endpoints: result.sort((a, b) => a.path.localeCompare(b.path)), warnings: [] };
}

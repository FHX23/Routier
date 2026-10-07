import type { AuthRequirement, HttpMethod, JsonSchema, MethodMetadata } from '../../types.js';
import {
  bodyFromFunctionExpression,
  findFunctionBody,
  findMethodBody,
  parseImports,
  resolveExportedLocal,
  splitTopLevel,
} from './code.js';
import { inferHeaders, inferQueryParams } from './request.js';
import type { SourceLoader } from './source.js';
import type { AuthDetector } from './auth.js';
import { firstParamName, inferNodeBody, inferTrackedQuery, type RequestBodyInference } from './flow.js';
import { applyBody, applyQuerySchema } from './metadata.js';
import { interpretSchema, interpretValidatorObject, type ValidatorObject } from './schemas.js';

const BODY_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH'];

/** Nombres típicos de middlewares que exigen autenticación (`requireAuth`, `passport.authenticate`, `verifyJwt`...). */
export const AUTH_MIDDLEWARE = /auth|jwt|protect|passport|guard|token|logged|bearer/i;

/** Nombres que contienen "auth" pero no protegen la ruta (configuración, rate limit, routers, validación). */
const NOT_AUTH = /initiali[sz]e|limit|(?:^|[^a-z])rate|throttle|route|controller|validat|schema|cors|log(?:ger|ging)|passport\.use|passport\.session/i;

/** Un middleware que exige autenticación (`requireAuth`, `passport.authenticate(...)`, `auth()`). */
export function isAuthMiddleware(text: string): boolean {
  return AUTH_MIDDLEWARE.test(text) && !NOT_AUTH.test(text);
}

export interface HandlerContext {
  filePath: string;
  loader: SourceLoader;
}

/** Resuelve un identificador (`create`, `usersController.create`) a un cuerpo de función, siguiendo imports. */
export async function resolveHandlerBody(expression: string, ctx: HandlerContext, depth = 0): Promise<string | null> {
  const text = expression.trim();
  if (depth > 3 || !text) return null;

  const inline = /^(async\b|function\b|\(|[\w$]+\s*=>)/.test(text) ? bodyFromFunctionExpression(text) : null;
  if (inline) return inline;

  const code = await ctx.loader.load(ctx.filePath);
  if (code === null) return null;

  const member = /^([\w$]+)\s*\.\s*([\w$]+)(?:\s*\.\s*bind\s*\([^)]*\))?$/.exec(text);
  const plain = /^([\w$]+)$/.exec(text);
  if (!member && !plain) return null;

  const objectName = member ? member[1] : null;
  const functionName = member ? member[2] : plain![1];

  // Mismo archivo: función, método de clase u objeto literal.
  const local = objectName ? findMethodBody(code, functionName) : findFunctionBody(code, functionName);
  if (local) return local;

  const imports = parseImports(code);
  const binding = imports.get(objectName ?? functionName);
  if (!binding) {
    // `const controller = new UsersController()` con la clase importada.
    if (objectName) {
      const instance = new RegExp(`(?:const|let|var)\\s+${objectName.replace(/\$/g, '\\$')}\\s*=\\s*new\\s+([\\w$]+)`).exec(code);
      if (instance) {
        const classBinding = imports.get(instance[1]);
        const target = classBinding ? ctx.loader.resolve(ctx.filePath, classBinding.specifier) : null;
        const targetCode = target ? await ctx.loader.load(target) : null;
        if (targetCode) return findMethodBody(targetCode, functionName);
      }
    }
    return null;
  }

  const target = ctx.loader.resolve(ctx.filePath, binding.specifier);
  const targetCode = target ? await ctx.loader.load(target) : null;
  if (!target || !targetCode) return null;

  if (objectName) {
    return findFunctionBody(targetCode, functionName) ?? findMethodBody(targetCode, functionName);
  }
  const exported = binding.imported === '*' ? functionName : resolveExportedLocal(targetCode, binding.imported) ?? functionName;
  return findFunctionBody(targetCode, exported) ?? findMethodBody(targetCode, exported);
}

/**
 * Middlewares de validación: `validate(schema)`, `validate({ body, query })`, `celebrate({...})`,
 * `zValidator('json', schema)`. Soporta Zod, Joi, TypeBox y JSON Schema.
 */
async function validatorFromCall(expression: string, ctx: HandlerContext): Promise<ValidatorObject | null> {
  const call = /^[\w$.]+\s*\(([\s\S]*)\)$/.exec(expression.trim());
  if (!call) return null;
  for (const arg of splitTopLevel(call[1])) {
    const text = arg.trim();
    if (!text || /^['"`]/.test(text) || /^(async\b|function\b|\()/.test(text)) continue;
    const object = await interpretValidatorObject(text, ctx.filePath, ctx.loader);
    if (object?.body || object?.query) return object;
    const schema = await interpretSchema(text, ctx.filePath, ctx.loader);
    if (schema?.properties) return { body: schema };
  }
  return null;
}

/** Campos de archivo declarados con multer: upload.single('avatar'), .array('photos'), .fields([...]). */
function multerFields(expression: string): Record<string, JsonSchema> | null {
  const match = /\.\s*(single|array|fields|any)\s*\(([^)]*)\)/.exec(expression);
  if (!match) return null;
  const binary: JsonSchema = { type: 'string', format: 'binary' };
  const names = [...match[2].matchAll(/['"`]([\w.-]+)['"`]/g)].map((m) => m[1]);
  if (match[1] === 'any' || names.length === 0) return { file: binary };
  return Object.fromEntries(names.map((name) => [name, match[1] === 'array' ? { type: 'array', items: binary } : binary]));
}

export interface InferHandlerOptions extends HandlerContext {
  method: HttpMethod;
  /** Argumentos de la ruta después del path: middlewares y handler final. */
  handlers: string[];
  routeParams: Set<string>;
  /** Heredado de middlewares de router o montajes (`app.use('/admin', requireAuth, admin)`). */
  inheritedAuth?: AuthRequirement;
  /** Detector de sesiones del proyecto. */
  authDetector?: AuthDetector;
}

export async function inferHandlerMetadata(options: InferHandlerOptions): Promise<MethodMetadata | undefined> {
  const { method, handlers, routeParams } = options;
  const isBodyMethod = BODY_METHODS.includes(method);
  const headers: string[] = [];
  const query: string[] = [];
  let auth = options.inheritedAuth;
  let validated: JsonSchema | undefined;
  let querySchema: JsonSchema | undefined;
  let usage: RequestBodyInference | null = null;
  let files: Record<string, JsonSchema> | null = null;

  const addQuery = (name: string) => {
    if (!routeParams.has(name) && !query.includes(name)) query.push(name);
  };

  for (const [index, handler] of handlers.entries()) {
    const isMiddleware = index < handlers.length - 1;
    const name = handler.trim().split('(')[0];

    if (isMiddleware && isAuthMiddleware(name)) {
      // `auth.optional` / `optionalAuth` no exige token; `auth.required`, `requireAuth`, `auth()` sí.
      const optional = /optional/i.test(handler);
      if (!auth || (auth.type === 'bearer' && auth.optional && !optional)) {
        auth = optional ? { type: 'bearer', optional: true } : { type: 'bearer' };
      }
    }
    if (isMiddleware) files ??= multerFields(handler);

    if (isMiddleware && (!validated || !querySchema)) {
      const validator = await validatorFromCall(handler, options);
      if (validator?.body && isBodyMethod) validated ??= validator.body;
      querySchema ??= validator?.query;
    }

    const handlerBody = await resolveHandlerBody(handler, options);
    if (!handlerBody) continue;
    const requestNames = [...new Set([firstParamName(handler.trim()) ?? 'req', 'req', 'request'])];
    // @fastify/multipart: request.file() / files() / parts(); multer: req.file / req.files
    if (isBodyMethod && /\b(?:req|request)\s*\.\s*(?:file|files|parts|saveRequestFiles)\s*\(/.test(handlerBody)) {
      files ??= { file: { type: 'string', format: 'binary' } };
    }

    for (const header of inferHeaders(handlerBody, { expressGetter: true })) {
      if (!headers.includes(header)) headers.push(header);
    }
    inferQueryParams(handlerBody).forEach(addQuery);
    (await inferTrackedQuery(handlerBody, requestNames.map((name) => ({ expr: `${name}.query`, path: [] })), options)).forEach(addQuery);

    if (!isMiddleware && options.authDetector && (!auth || auth.type === 'bearer' && auth.optional)) {
      const session = await options.authDetector.sessionRequirement(handlerBody, options.filePath);
      if (session) auth = session;
    }
    if (isBodyMethod && !validated && (!usage || usage.source === 'usage')) {
      const inferred = await inferNodeBody(handlerBody, requestNames, options);
      if (inferred && (!usage || inferred.source !== 'usage')) usage = inferred;
    }
  }

  if (!auth && headers.includes('Authorization')) auth = { type: 'bearer' };

  const meta: MethodMetadata = {};
  if (auth) meta.auth = auth;
  if (auth?.type === 'bearer' && !headers.includes('Authorization')) headers.unshift('Authorization');
  if (headers.length > 0) meta.headers = headers;
  if (query.length > 0) meta.query = query;
  applyQuerySchema(meta, querySchema);

  if (isBodyMethod) {
    if (files) {
      const textFields = validated?.properties ?? usage?.schema?.properties ?? {};
      applyBody(meta, { contentType: 'multipart/form-data', schema: { type: 'object', properties: { ...textFields, ...files } } });
    } else if (validated) {
      applyBody(meta, { contentType: 'application/json', schema: validated, source: 'schema' });
    } else if (usage?.schema) {
      applyBody(meta, usage);
    }
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Normaliza un path de Express/Fastify al formato interno (`/users/:id`). */
export function normalizeRoutePath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\{\/?([^}]*)\}/g, '/$1') // Express 5: '/users{/:id}' -> '/users/:id'
    .replace(/\/\*([\w$]+)/g, '/:$1') // Express 5: '/*splat' -> '/:splat'
    .replace(/\/\*(?=\/|$)/g, '/:wildcard')
    .replace(/:([\w$]+)\?/g, ':$1') // '/:id?' -> '/:id'
    .replace(/\/{2,}/g, '/');
  const withSlash = joined.startsWith('/') ? joined : `/${joined}`;
  return withSlash.length > 1 ? withSlash.replace(/\/$/, '') : withSlash;
}

export function routeParamsOf(routePath: string): Set<string> {
  return new Set([...routePath.matchAll(/:([\w$]+)/g)].map((match) => match[1]));
}

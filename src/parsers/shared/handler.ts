import type { HttpMethod, JsonSchema, MethodMetadata } from '../../types.js';
import {
  bodyFromFunctionExpression,
  findFunctionBody,
  findMethodBody,
  parseImports,
  resolveExportedLocal,
} from './code.js';
import { inferHeaders, inferQueryParams } from './request.js';
import type { SourceLoader } from './source.js';
import { exampleFromSchema, inferZodBody, inferZodSchemaByName } from './zod.js';

const BODY_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH'];

/** Nombres típicos de middlewares que exigen autenticación (`requireAuth`, `passport.authenticate`, `verifyJwt`...). */
export const AUTH_MIDDLEWARE = /auth|jwt|protect|passport|guard|token|logged|bearer/i;

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

/** Busca schemas Zod pasados a middlewares de validación: `validate(schema)`, `validateBody({ body: schema })`. */
async function schemaFromValidatorCall(expression: string, ctx: HandlerContext): Promise<{ schema: JsonSchema; example: unknown } | null> {
  const call = /^[\w$.]+\s*\(([\s\S]*)\)$/.exec(expression.trim());
  if (!call) return null;
  const identifiers = [...call[1].matchAll(/(?:^|[\s,{(:])([A-Za-z_$][\w$]*)(?=\s*[,)}]|\s*$)/g)].map((match) => match[1]);
  for (const name of identifiers) {
    const inferred = await inferZodSchemaByName(name, ctx.filePath, ctx.loader);
    if (inferred?.schema.properties) return inferred;
  }
  return null;
}

export interface InferHandlerOptions extends HandlerContext {
  method: HttpMethod;
  /** Argumentos de la ruta después del path: middlewares y handler final. */
  handlers: string[];
  routeParams: Set<string>;
  /** Heredado de middlewares de router o montajes (`app.use('/admin', requireAuth, admin)`). */
  requiresAuth?: boolean;
}

export async function inferHandlerMetadata(options: InferHandlerOptions): Promise<MethodMetadata | undefined> {
  const { method, handlers, routeParams } = options;
  const headers: string[] = [];
  const query: string[] = [];
  let body: { schema: JsonSchema; example: unknown } | null = null;
  let requiresAuth = options.requiresAuth ?? false;

  for (const [index, handler] of handlers.entries()) {
    const isMiddleware = index < handlers.length - 1;
    const name = handler.trim().split('(')[0];
    if (isMiddleware && AUTH_MIDDLEWARE.test(name)) requiresAuth = true;

    if (BODY_METHODS.includes(method) && !body) {
      body = await schemaFromValidatorCall(handler, options);
    }

    const handlerBody = await resolveHandlerBody(handler, options);
    if (!handlerBody) continue;

    for (const header of inferHeaders(handlerBody, { expressGetter: true })) {
      if (!headers.includes(header)) headers.push(header);
    }
    for (const param of inferQueryParams(handlerBody)) {
      if (!routeParams.has(param) && !query.includes(param)) query.push(param);
    }
    if (BODY_METHODS.includes(method) && !body) {
      body = await inferZodBody(handlerBody, options.filePath, options.loader);
    }
  }

  if (requiresAuth && !headers.includes('Authorization')) headers.unshift('Authorization');

  const meta: MethodMetadata = {};
  if (headers.length > 0) meta.headers = headers;
  if (query.length > 0) meta.query = query;
  if (body) {
    meta.body = JSON.stringify(body.example ?? exampleFromSchema(body.schema), null, 2);
    meta.bodySchema = body.schema;
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

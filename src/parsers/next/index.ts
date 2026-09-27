import fg from 'fast-glob';
import path from 'node:path';
import type { Endpoint, HttpMethod, MethodMetadata } from '../../types.js';
import { findFunctionBody } from '../shared/code.js';
import { inferHeaders, inferQueryParams } from '../shared/request.js';
import { SourceLoader } from '../shared/source.js';
import { AuthDetector } from '../shared/auth.js';
import { inferFetchBody, inferNodeBody } from '../shared/flow.js';
import { applyBody } from '../shared/metadata.js';

interface NextScanOptions {
  cwd?: string;
  exclude?: string[];
}

const STANDARD_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const BODY_METHODS: HttpMethod[] = ['POST', 'PUT', 'PATCH'];
export const DEFAULT_IGNORE = ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', '**/out/**', '**/routier-exports/**'];

const TEST_FILE = /\.(test|spec)\.[jt]sx?$|\.d\.ts$/;

/**
 * Convierte los segmentos de carpetas de Next.js en una ruta HTTP.
 * Devuelve `null` si la ruta no es pública (carpetas privadas `_x` o rutas interceptadas `(.)x`).
 */
function segmentsToPath(segments: string[]): string | null {
  const parts: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith('_')) return null;
    if (/^\(\.{1,3}\)/.test(segment) || segment.startsWith('(...)')) return null;
    if (/^\(.*\)$/.test(segment)) continue;
    if (segment.startsWith('@')) continue;

    const catchAll = segment.match(/^\[\[?\.\.\.([^\]]+)\]?\]$/);
    if (catchAll) { parts.push(`:${catchAll[1]}`); continue; }
    const dynamic = segment.match(/^\[([^\]]+)\]$/);
    if (dynamic) { parts.push(`:${dynamic[1]}`); continue; }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/** Ubica el directorio `app/` o `pages/` que define las rutas, anclado a un segmento completo. */
function routeSegments(file: string, marker: RegExp): string[] | null {
  const normalized = file.replace(/\\/g, '/');
  const match = marker.exec(normalized);
  if (!match) return null;
  return normalized.slice(match.index + match[0].length).split('/');
}

function pathParams(routePath: string): Set<string> {
  return new Set([...routePath.matchAll(/:([\w]+)/g)].map((m) => m[1]));
}

function isGraphQLPath(routePath: string): boolean {
  return routePath === '/graphql' || routePath.endsWith('/graphql');
}

function detectAppRouterMethods(code: string): HttpMethod[] {
  const methods: HttpMethod[] = [];
  const destructured = [...code.matchAll(/export\s+const\s*\{([^}]*)\}\s*=/g)].map((m) => m[1]).join(',');

  for (const method of STANDARD_METHODS) {
    const inline = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s*\\*?|const|let|var)\\s+${method}\\b`);
    const block = new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`);
    const fromDestructuring = new RegExp(`\\b${method}\\b`).test(destructured);
    if (inline.test(code) || block.test(code) || fromDestructuring) {
      methods.push(method);
    }
  }
  return methods;
}

/** Resuelve el nombre local de un método exportado (`export { handler as GET }` -> `handler`). */
function localNameForMethod(code: string, method: HttpMethod): string {
  for (const block of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) {
      const [local, exported] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if ((exported ?? local) === method) return local;
    }
  }
  return method;
}

function detectPagesRouterMethods(code: string): HttpMethod[] {
  const methods: HttpMethod[] = [];
  for (const method of STANDARD_METHODS) {
    const patterns = [
      new RegExp(`\\.method\\s*={2,3}\\s*['"\`]${method}['"\`]`),
      new RegExp(`['"\`]${method}['"\`]\\s*={2,3}\\s*[\\w$.]*\\.method\\b`),
      new RegExp(`case\\s+['"\`]${method}['"\`]\\s*:`),
    ];
    if (patterns.some((pattern) => pattern.test(code))) {
      methods.push(method);
    }
  }
  return methods.length > 0 ? methods : ['GET', 'POST'];
}

interface InferContext {
  filePath: string;
  loader: SourceLoader;
  auth: AuthDetector;
  routePath: string;
  router: 'app' | 'pages';
}

async function inferMetadata(handlerBody: string, method: HttpMethod, ctx: InferContext): Promise<MethodMetadata | undefined> {
  const { filePath, loader } = ctx;
  const routeParams = pathParams(ctx.routePath);
  const meta: MethodMetadata = {};

  const headers = inferHeaders(handlerBody);
  const session = await ctx.auth.sessionRequirement(handlerBody, filePath);
  const middleware = await ctx.auth.nextMiddleware();
  if (session) {
    meta.auth = session;
  } else if (middleware?.(ctx.routePath)) {
    meta.auth = { type: 'session', cookie: await ctx.auth.middlewareCookie() };
  } else if (headers.includes('Authorization')) {
    meta.auth = { type: 'bearer' };
  }
  if (headers.length > 0) meta.headers = headers;

  const query = inferQueryParams(handlerBody).filter((name) => !routeParams.has(name));
  if (query.length > 0) meta.query = query;

  if (BODY_METHODS.includes(method)) {
    const flowCtx = { filePath, loader };
    const body = ctx.router === 'app'
      ? await inferFetchBody(handlerBody, flowCtx)
      : await inferNodeBody(handlerBody, ['req', 'request'], flowCtx);
    applyBody(meta, body);
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

export async function scanNextRoutes(options: NextScanOptions = {}): Promise<Endpoint[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];
  const loader = new SourceLoader(cwd);
  const auth = new AuthDetector(cwd, loader);
  const endpoints: Endpoint[] = [];

  const appRouterFiles = await fg(['**/app/**/route.{ts,js,mjs}'], { cwd, ignore });
  for (const file of appRouterFiles) {
    const segments = routeSegments(file, /(?:^|\/)app\//);
    if (!segments) continue;
    const routePath = segmentsToPath(segments.slice(0, -1));
    if (!routePath) continue;

    const absolute = path.join(cwd, file);
    const code = (await loader.load(absolute)) ?? '';
    const isGraphQL = isGraphQLPath(routePath);
    const detected = detectAppRouterMethods(code);
    // GraphQL: se respetan los métodos exportados (GET/POST/OPTIONS), asegurando POST.
    const methods: HttpMethod[] = isGraphQL
      ? [...new Set<HttpMethod>(['POST', ...detected])]
      : detected.length > 0 ? detected : ['GET'];

    const methodsMetadata: Endpoint['methodsMetadata'] = {};
    if (isGraphQL) {
      // La autenticación de GraphQL suele resolverse al construir el contexto del servidor.
      const session = await auth.sessionRequirement(code, absolute);
      if (session) methodsMetadata.POST = { auth: session };
    } else {
      for (const method of methods) {
        const body = findFunctionBody(code, localNameForMethod(code, method));
        if (!body) continue;
        const meta = await inferMetadata(body, method, { filePath: absolute, loader, auth, routePath, router: 'app' });
        if (meta) methodsMetadata[method] = meta;
      }
    }

    endpoints.push({
      path: routePath,
      methods,
      fileType: isGraphQL ? 'graphql' : 'rest',
      sourceFile: file,
      router: 'app',
      methodsMetadata: Object.keys(methodsMetadata).length > 0 ? methodsMetadata : undefined,
    });
  }

  const pagesRouterFiles = await fg(['**/pages/api/**/*.{ts,js,tsx,jsx,mjs}'], { cwd, ignore });
  for (const file of pagesRouterFiles) {
    if (TEST_FILE.test(file)) continue;
    const segments = routeSegments(file, /(?:^|\/)pages\//);
    if (!segments) continue;

    const last = segments[segments.length - 1].replace(/\.[mc]?[jt]sx?$/, '');
    const routeParts = last === 'index' ? segments.slice(0, -1) : [...segments.slice(0, -1), last];
    const routePath = segmentsToPath(routeParts);
    if (!routePath) continue;

    const absolute = path.join(cwd, file);
    const code = (await loader.load(absolute)) ?? '';
    const isGraphQL = isGraphQLPath(routePath);
    const methods: HttpMethod[] = isGraphQL ? ['POST'] : detectPagesRouterMethods(code);

    // Pages Router expone un único handler: la inferencia se hace sobre todo el archivo.
    const methodsMetadata: Endpoint['methodsMetadata'] = {};
    if (!isGraphQL) {
      for (const method of methods) {
        const meta = await inferMetadata(code, method, { filePath: absolute, loader, auth, routePath, router: 'pages' });
        if (meta) methodsMetadata[method] = meta;
      }
    }

    endpoints.push({
      path: routePath,
      methods,
      fileType: isGraphQL ? 'graphql' : 'rest',
      sourceFile: file,
      router: 'pages',
      methodsMetadata: Object.keys(methodsMetadata).length > 0 ? methodsMetadata : undefined,
    });
  }

  return endpoints.sort((a, b) => a.path.localeCompare(b.path));
}

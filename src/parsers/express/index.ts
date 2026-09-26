import fg from 'fast-glob';
import path from 'node:path';
import type { Endpoint, HttpMethod } from '../../types.js';
import type { AdapterOptions, AdapterResult } from '../index.js';
import { findMatching, parseImports, parseStringLiteral, resolveExportedLocal, splitTopLevel } from '../shared/code.js';
import { AUTH_MIDDLEWARE, inferHandlerMetadata, normalizeRoutePath, routeParamsOf } from '../shared/handler.js';
import { SourceLoader } from '../shared/source.js';
import { DEFAULT_IGNORE } from '../next/index.js';

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

export const SOURCE_GLOB = '**/*.{ts,js,mjs,cjs,mts,cts}';
export const SOURCE_IGNORE = [...DEFAULT_IGNORE, '**/*.d.ts', '**/*.{test,spec}.*', '**/__tests__/**', '**/coverage/**'];

interface Registration {
  methods: HttpMethod[];
  path: string;
  handlers: string[];
}

interface Mount {
  prefix: string;
  args: string[];
}

interface FileInfo {
  file: string;
  absolute: string;
  code: string;
  /** Identificadores creados con `express()` / `Router()`. */
  routers: Set<string>;
  registrations: Map<string, Registration[]>;
  mounts: Map<string, Mount[]>;
}

interface Edge {
  child: string;
  prefix: string;
  auth: boolean;
}

function pathsFromArg(arg: string): string[] | null {
  const single = parseStringLiteral(arg);
  if (single !== null) return [single];
  const trimmed = arg.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const items = splitTopLevel(trimmed.slice(1, -1)).map(parseStringLiteral);
    return items.every((item): item is string => item !== null) ? items : null;
  }
  return null;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T) {
  map.set(key, [...(map.get(key) ?? []), value]);
}

/** Lee `.verb(args)` encadenados después de `index` (para `router.route('/x').get(...).post(...)`). */
function readChain(code: string, index: number): { verb: string; args: string[] }[] {
  const chain: { verb: string; args: string[] }[] = [];
  let i = index;
  while (true) {
    const next = /^\s*\.\s*([\w$]+)\s*\(/.exec(code.slice(i));
    if (!next) break;
    const open = i + next[0].length - 1;
    const close = findMatching(code, open);
    if (close === -1) break;
    chain.push({ verb: next[1], args: splitTopLevel(code.slice(open + 1, close)) });
    i = close + 1;
  }
  return chain;
}

export function analyseExpressFile(file: string, absolute: string, code: string): FileInfo {
  const info: FileInfo = { file, absolute, code, routers: new Set(), registrations: new Map(), mounts: new Map() };

  const declaration = /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:express\s*\(|(?:express\s*\.\s*)?Router\s*\(|new\s+Router\s*\()/g;
  for (const match of code.matchAll(declaration)) info.routers.add(match[1]);

  const call = /(?<![\w$.])([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|all|use|route)\s*\(/g;
  for (const match of code.matchAll(call)) {
    const [, receiver, verb] = match;
    const open = match.index! + match[0].length - 1;
    const close = findMatching(code, open);
    if (close === -1) continue;
    const args = splitTopLevel(code.slice(open + 1, close));

    if (verb === 'route') {
      const paths = args[0] ? pathsFromArg(args[0]) : null;
      if (!paths) continue;
      for (const link of readChain(code, close + 1)) {
        const methods = VERBS[link.verb];
        if (!methods || link.args.length === 0) continue;
        for (const routePath of paths) pushTo(info.registrations, receiver, { methods, path: routePath, handlers: link.args });
      }
      continue;
    }

    if (verb === 'use') {
      if (args.length === 0) continue;
      const prefix = pathsFromArg(args[0]);
      pushTo(info.mounts, receiver, { prefix: prefix?.[0] ?? '', args: prefix ? args.slice(1) : args });
      continue;
    }

    // Registro de ruta: requiere un path literal y al menos un handler (descarta `map.get('/x')` o `app.get('env')`).
    if (args.length < 2) continue;
    const paths = pathsFromArg(args[0]);
    if (!paths || !paths.every((p) => p.startsWith('/') || p === '*')) continue;
    for (const routePath of paths) {
      pushTo(info.registrations, receiver, { methods: VERBS[verb], path: routePath, handlers: args.slice(1) });
    }
  }

  return info;
}

function nodeId(file: string, ident: string) {
  return `${file}#${ident}`;
}

function routerNodesOf(info: FileInfo): string[] {
  const idents = new Set([...info.routers, ...info.registrations.keys(), ...info.mounts.keys()]);
  return [...idents].map((ident) => nodeId(info.file, ident));
}

/**
 * Resuelve el argumento de un `use()` a los routers que monta. Devuelve una lista vacía
 * si el argumento no es un router (es decir, es un middleware).
 */
async function resolveMountTarget(
  arg: string,
  info: FileInfo,
  files: Map<string, FileInfo>,
  loader: SourceLoader,
  cwd: string,
): Promise<string[]> {
  const text = arg.trim();
  const fileOf = (absolute: string) => files.get(path.relative(cwd, absolute).replace(/\\/g, '/'));

  const inlineRequire = /^require\s*\(\s*(['"])([^'"]+)\1\s*\)$/.exec(text);
  const callee = /^([\w$]+)\s*\(/.exec(text);
  const ident = /^[\w$]+$/.test(text) ? text : callee?.[1] ?? null;

  if (!inlineRequire && ident && !callee && (info.routers.has(ident) || info.registrations.has(ident) || info.mounts.has(ident))) {
    return [nodeId(info.file, ident)];
  }

  let specifier: string | null = null;
  let imported = 'default';
  if (inlineRequire) {
    specifier = inlineRequire[2];
  } else if (ident) {
    const binding = parseImports(info.code).get(ident);
    if (binding) {
      specifier = binding.specifier;
      imported = binding.imported;
    }
  }
  if (!specifier) return [];

  const target = loader.resolve(info.absolute, specifier);
  const targetInfo = target ? fileOf(target) : undefined;
  if (!targetInfo) return [];

  // Una fábrica (`createUsersRouter(db)`) monta los routers que declara su módulo.
  if (!callee && imported !== '*') {
    const local = resolveExportedLocal(targetInfo.code, imported);
    if (local && (targetInfo.routers.has(local) || targetInfo.registrations.has(local) || targetInfo.mounts.has(local))) {
      return [nodeId(targetInfo.file, local)];
    }
  }
  return routerNodesOf(targetInfo);
}

export async function scanExpressRoutes(options: AdapterOptions): Promise<AdapterResult> {
  const cwd = path.resolve(options.cwd);
  const loader = new SourceLoader(cwd);
  const warnings: string[] = [];
  const files = new Map<string, FileInfo>();

  const sourceFiles = await fg([SOURCE_GLOB], { cwd, ignore: [...SOURCE_IGNORE, ...(options.exclude ?? [])] });
  for (const file of sourceFiles) {
    const absolute = path.join(cwd, file);
    const code = await loader.load(absolute);
    if (!code || !/\.\s*(?:get|post|put|patch|delete|all|use|route)\s*\(/.test(code)) continue;
    // Evita confundir código de cliente (`axios.get('/x', config)`) con rutas: el archivo debe usar Express.
    if (!/\bexpress\b|\bRouter\s*\(/.test(code)) continue;
    const info = analyseExpressFile(file, absolute, code);
    if (info.registrations.size > 0 || info.mounts.size > 0) files.set(file, info);
  }

  // Grafo de montajes: padre -> hijos con prefijo; también middlewares de auth por router.
  const edges = new Map<string, Edge[]>();
  const children = new Set<string>();
  const nodeAuth = new Set<string>();
  const graphqlEndpoints: Endpoint[] = [];

  for (const info of files.values()) {
    for (const [receiver, mounts] of info.mounts) {
      const parent = nodeId(info.file, receiver);
      for (const mount of mounts) {
        const targets: string[] = [];
        let edgeAuth = false;
        for (const arg of mount.args) {
          const resolved = await resolveMountTarget(arg, info, files, loader, cwd);
          if (resolved.length > 0) {
            targets.push(...resolved);
          } else if (AUTH_MIDDLEWARE.test(arg.split('(')[0])) {
            edgeAuth = true;
          }
        }

        if (targets.length === 0) {
          if (/\/graphql$/.test(mount.prefix)) {
            graphqlEndpoints.push({ path: normalizeRoutePath(mount.prefix), methods: ['POST'], fileType: 'graphql', sourceFile: info.file, router: 'express' });
          } else if (edgeAuth && !mount.prefix) {
            nodeAuth.add(parent);
          }
          continue;
        }

        for (const child of targets) {
          if (child === parent) continue;
          pushTo(edges, parent, { child, prefix: mount.prefix, auth: edgeAuth });
          children.add(child);
        }
      }
    }
  }

  // Recorre desde las raíces (routers que nadie monta) acumulando prefijos.
  const placements = new Map<string, { prefix: string; auth: boolean }[]>();
  const visit = (node: string, prefix: string, auth: boolean, trail: Set<string>) => {
    if (trail.has(node)) {
      warnings.push(`Circular router mount detected at ${node.replace('#', ' -> ')}.`);
      return;
    }
    const withAuth = auth || nodeAuth.has(node);
    pushTo(placements, node, { prefix, auth: withAuth });
    const nextTrail = new Set(trail).add(node);
    for (const edge of edges.get(node) ?? []) {
      visit(edge.child, normalizeRoutePath(prefix, edge.prefix), withAuth || edge.auth, nextTrail);
    }
  };

  const allNodes = [...files.values()].flatMap(routerNodesOf);
  for (const node of allNodes) {
    if (!children.has(node)) visit(node, '', false, new Set());
  }

  const endpoints = new Map<string, Endpoint>();
  for (const info of files.values()) {
    for (const [receiver, registrations] of info.registrations) {
      const node = nodeId(info.file, receiver);
      for (const placement of placements.get(node) ?? [{ prefix: '', auth: false }]) {
        for (const registration of registrations) {
          const routePath = normalizeRoutePath(placement.prefix, registration.path);
          const key = `${routePath} ${info.file}`;
          const endpoint = endpoints.get(key) ?? {
            path: routePath,
            methods: [],
            fileType: 'rest' as const,
            sourceFile: info.file,
            router: 'express' as const,
          };
          endpoints.set(key, endpoint);

          for (const method of registration.methods) {
            if (endpoint.methods.includes(method)) continue;
            endpoint.methods.push(method);
            const meta = await inferHandlerMetadata({
              filePath: info.absolute,
              loader,
              method,
              handlers: registration.handlers,
              routeParams: routeParamsOf(routePath),
              requiresAuth: placement.auth,
            });
            if (meta) endpoint.methodsMetadata = { ...endpoint.methodsMetadata, [method]: meta };
          }
        }
      }
    }
  }

  return {
    endpoints: [...endpoints.values(), ...graphqlEndpoints].sort((a, b) => a.path.localeCompare(b.path)),
    warnings,
  };
}

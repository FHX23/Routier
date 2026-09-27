import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuthRequirement } from '../../types.js';
import { findFunction, parseImports, parseStringLiteral, resolveExportedLocal } from './code.js';
import type { SourceLoader } from './source.js';

/**
 * Detección de autenticación por sesión (cookie) y por token, incluyendo helpers
 * importados que llaman a la librería de sesión y el middleware/proxy de Next.js.
 */

type SessionLibrary = 'next-auth' | 'better-auth' | 'clerk' | 'supabase' | 'lucia' | 'iron-session' | 'node-session';

const SESSION_PATTERNS: [RegExp, SessionLibrary][] = [
  [/\bauth\s*\.\s*api\s*\.\s*getSession\s*\(/, 'better-auth'],
  [/\bgetSessionCookie\s*\(/, 'better-auth'],
  [/\bgetServerSession\s*\(/, 'next-auth'],
  [/\bgetToken\s*\(\s*\{\s*req/, 'next-auth'],
  [/\bcurrentUser\s*\(\s*\)/, 'clerk'],
  [/\bsupabase\s*\.\s*auth\s*\.\s*getUser\s*\(/, 'supabase'],
  [/\bvalidateRequest\s*\(\s*\)/, 'lucia'],
  [/\bgetIronSession\s*\(/, 'iron-session'],
  // Solo cuando se verifica la sesión (no cuando se asigna, como en un login).
  [/(?:!\s*|if\s*\(\s*)(?:req|request)\s*\.\s*session\b|(?:req|request)\s*\.\s*session\s*\??\.\s*(?:user|userId|passport)\b(?!\s*=[^=])\s*(?:\)|&&|\|\||===|!==|\?\?)/, 'node-session'],
];

/** `auth()` de next-auth v5 o Clerk: solo cuenta si `auth` es un import, no una variable cualquiera. */
const AUTH_CALL = /(?<![\w$.])auth\s*\(\s*\)/;

const COOKIE_BY_LIBRARY: Record<SessionLibrary, string> = {
  'next-auth': 'authjs.session-token',
  'better-auth': 'better-auth.session_token',
  clerk: '__session',
  supabase: 'sb-access-token',
  lucia: 'auth_session',
  'iron-session': 'session',
  'node-session': 'connect.sid',
};

async function readDeps(cwd: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

export class AuthDetector {
  private deps: Promise<Record<string, string>>;
  private cache = new Map<string, Promise<SessionLibrary | null>>();
  /** Claves en resolución: una llamada recursiva (A -> B -> A) no debe esperar su propia promesa. */
  private inProgress = new Set<string>();

  private memo(key: string, compute: () => Promise<SessionLibrary | null>): Promise<SessionLibrary | null> {
    if (this.inProgress.has(key)) return Promise.resolve(null);
    let pending = this.cache.get(key);
    if (!pending) {
      this.inProgress.add(key);
      pending = compute().finally(() => this.inProgress.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }

  constructor(private cwd: string, private loader: SourceLoader) {
    this.deps = readDeps(cwd);
  }

  /** Nombre de la cookie de sesión según la librería y su versión. */
  async cookieFor(library: SessionLibrary): Promise<string> {
    const deps = await this.deps;
    if (library === 'next-auth') {
      const version = deps['next-auth'] ?? '';
      return /(^|[^\d])4\./.test(version) ? 'next-auth.session-token' : 'authjs.session-token';
    }
    if (library === 'node-session') {
      if (deps['@fastify/session'] || deps['@fastify/secure-session']) return 'sessionId';
      return 'connect.sid';
    }
    return COOKIE_BY_LIBRARY[library];
  }

  /** Librería de sesión usada directamente en `code` (sin seguir llamadas). */
  private directLibrary(code: string, filePath: string, imports: ReturnType<typeof parseImports>): SessionLibrary | null {
    for (const [pattern, library] of SESSION_PATTERNS) {
      if (pattern.test(code)) return library;
    }
    if (AUTH_CALL.test(code)) {
      const binding = imports.get('auth');
      if (binding) return binding.specifier.startsWith('@clerk') ? 'clerk' : 'next-auth';
      // `const { auth } = NextAuth(config)` en el mismo archivo
      if (/\{\s*[^}]*\bauth\b[^}]*\}\s*=\s*NextAuth\s*\(/.test(code)) return 'next-auth';
    }
    void filePath;
    return null;
  }

  /**
   * Busca uso de sesión en el cuerpo de un handler, siguiendo funciones importadas del propio
   * proyecto (p. ej. `getTenantIdOrFail()` que llama a `auth()`) hasta dos niveles.
   */
  async sessionLibrary(code: string, filePath: string, depth = 0): Promise<SessionLibrary | null> {
    const fileCode = (await this.loader.load(filePath)) ?? '';
    const imports = parseImports(fileCode);
    const direct = this.directLibrary(code, filePath, imports);
    if (direct || depth >= 2) return direct;

    for (const match of code.matchAll(/(?<![\w$.])([\w$]+)\s*\(/g)) {
      const name = match[1];
      const binding = imports.get(name);
      if (!binding) {
        // Función auxiliar del mismo archivo (p. ej. verifyCurrentUserHasAccessToPost()).
        const localLibrary = await this.memo(`${filePath}#local#${name}`, async () => {
          const fn = /^(if|for|while|switch|catch|function|return|await|typeof)$/.test(name) ? null : findFunction(fileCode, name);
          return fn && fn.body !== code ? this.sessionLibrary(fn.body, filePath, depth + 1) : null;
        });
        if (localLibrary) return localLibrary;
        continue;
      }
      const target = this.loader.resolve(filePath, binding.specifier);
      if (!target) continue;
      const library = await this.memo(`${target}#${binding.imported}`, async () => {
        const targetCode = await this.loader.load(target);
        if (!targetCode) return null;
        const local = binding.imported === 'default' ? resolveExportedLocal(targetCode, 'default') : binding.imported;
        const fn = local ? findFunction(targetCode, local) : null;
        return fn ? this.sessionLibrary(fn.body, target, depth + 1) : null;
      });
      if (library) return library;
    }
    return null;
  }

  async sessionRequirement(code: string, filePath: string): Promise<AuthRequirement | undefined> {
    const library = await this.sessionLibrary(code, filePath);
    return library ? { type: 'session', cookie: await this.cookieFor(library) } : undefined;
  }

  private middleware?: Promise<((route: string) => boolean) | null>;

  /**
   * Protección global del middleware/proxy de Next.js: devuelve una función que indica si
   * una ruta de la API queda protegida por sesión, o `null` si el middleware no protege la API.
   */
  nextMiddleware(): Promise<((route: string) => boolean) | null> {
    this.middleware ??= this.readNextMiddleware();
    return this.middleware;
  }

  async middlewareCookie(): Promise<string> {
    const deps = await this.deps;
    if (deps['better-auth']) return this.cookieFor('better-auth');
    if (deps['@clerk/nextjs']) return this.cookieFor('clerk');
    return this.cookieFor('next-auth');
  }

  private async readNextMiddleware(): Promise<((route: string) => boolean) | null> {
    const candidates = ['middleware', 'proxy'].flatMap((name) =>
      ['', 'src'].flatMap((dir) => ['ts', 'js', 'mjs'].map((ext) => path.join(this.cwd, dir, `${name}.${ext}`))),
    );
    for (const file of candidates) {
      const code = await this.loader.load(file);
      if (!code) continue;

      const protects =
        /export\s+default\s+(?:auth|withAuth|clerkMiddleware|authMiddleware)\s*\(/.test(code) ||
        /export\s*\{\s*auth\s+as\s+(?:middleware|proxy|default)\s*\}/.test(code) ||
        (/(getToken|getSessionCookie|auth\.api\.getSession|req\.auth|getServerSession)\b/.test(code) && /(redirect|status:\s*401|unauthorized)/i.test(code));
      if (!protects) return null;

      const matcherBlock = /matcher\s*:\s*(\[[\s\S]*?\]|(['"`])[^'"`]*\2)/.exec(code);
      const matchers = matcherBlock
        ? [...matcherBlock[1].matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => parseStringLiteral(m[0]) ?? m[2])
        : ['/:path*'];
      const regexes = matchers.map(matcherToRegex).filter((regex): regex is RegExp => regex !== null);

      // Rutas públicas: literales '/api/...' mencionados en el middleware (listas de excepciones).
      // `/api` y `/api/` sueltos suelen ser condiciones generales (`startsWith('/api/')`), no excepciones.
      const publicPrefixes = [...code.matchAll(/(['"`])(\/api\/[^'"`\s]+)\1/g)].map((m) => m[2]);

      return (route: string) => {
        if (!regexes.some((regex) => regex.test(route))) return false;
        return !publicPrefixes.some((prefix) => route.startsWith(prefix));
      };
    }
    return null;
  }
}

/** Convierte un matcher de Next.js (sintaxis path-to-regexp con grupos regex) en una RegExp. */
function matcherToRegex(matcher: string): RegExp | null {
  const source = matcher
    .replace(/:[\w]+\*/g, '.*')
    .replace(/:[\w]+\+/g, '.+')
    .replace(/:[\w]+\?/g, '[^/]*')
    .replace(/:[\w]+/g, '[^/]+');
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

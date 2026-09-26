import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from './code.js';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/**
 * Lee archivos fuente una sola vez (ya sin comentarios) y resuelve imports relativos
 * y alias comunes (`@/` y `~/` -> `src/` o la raíz del proyecto).
 */
export class SourceLoader {
  private cache = new Map<string, Promise<string | null>>();

  constructor(readonly cwd: string) {}

  load(absolutePath: string): Promise<string | null> {
    const key = path.resolve(absolutePath);
    let cached = this.cache.get(key);
    if (!cached) {
      cached = readFile(key, 'utf-8').then(stripComments, () => null);
      this.cache.set(key, cached);
    }
    return cached;
  }

  /** Resuelve `specifier` importado desde `fromFile` a una ruta absoluta existente, o `null` si es un paquete externo. */
  resolve(fromFile: string, specifier: string): string | null {
    let base: string[];
    if (specifier.startsWith('.')) {
      base = [path.resolve(path.dirname(fromFile), specifier)];
    } else if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
      const rest = specifier.slice(2);
      base = [path.resolve(this.cwd, 'src', rest), path.resolve(this.cwd, rest)];
    } else {
      return null;
    }

    for (const candidate of base) {
      // `./schemas.js` en TS suele apuntar a `./schemas.ts`.
      const withoutJs = candidate.replace(/\.(m|c)?js$/, '');
      const options = [
        candidate,
        ...EXTENSIONS.map((ext) => `${withoutJs}${ext}`),
        ...EXTENSIONS.map((ext) => path.join(candidate, `index${ext}`)),
      ];
      for (const option of options) {
        if (/\.[mc]?[jt]sx?$/.test(option) && existsSync(option)) return option;
      }
    }
    return null;
  }
}

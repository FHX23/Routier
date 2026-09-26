/**
 * Utilidades léxicas mínimas para analizar código JS/TS sin un parser completo.
 * Todas respetan strings, template literals y (heurísticamente) literales regex,
 * de modo que llaves o `//` dentro de un string no rompen el análisis.
 */

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^']);

function isRegexStart(code: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return true;
  if (REGEX_PRECEDERS.has(code[i])) return true;
  const before = code.slice(Math.max(0, i - 5), i + 1);
  return /\b(return|typeof|case|in|of)$/.test(before);
}

/** Devuelve el índice del carácter que cierra el string/template/regex que abre en `start`. */
function skipLiteral(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;

  if (quote === '/') {
    let inClass = false;
    for (; i < code.length; i++) {
      const char = code[i];
      if (char === '\\') { i++; continue; }
      if (char === '\n') return i - 1;
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) return i;
    }
    return code.length - 1;
  }

  for (; i < code.length; i++) {
    const char = code[i];
    if (char === '\\') { i++; continue; }
    if (quote === '`' && char === '$' && code[i + 1] === '{') {
      i = findMatching(code, i + 1);
      if (i === -1) return code.length - 1;
      continue;
    }
    if (char === quote) return i;
    if (quote !== '`' && char === '\n') return i - 1;
  }
  return code.length - 1;
}

function isLiteralStart(code: string, index: number): boolean {
  const char = code[index];
  if (char === '"' || char === "'" || char === '`') return true;
  if (char === '/' && code[index + 1] !== '/' && code[index + 1] !== '*') return isRegexStart(code, index);
  return false;
}

/**
 * Reemplaza comentarios por espacios (conservando saltos de línea y longitud),
 * sin tocar el contenido de strings, templates ni regex.
 */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];

    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }

    if (isLiteralStart(code, i)) {
      const end = skipLiteral(code, i);
      out += code.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    out += char;
    i++;
  }
  return out;
}

const PAIRS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/**
 * Dado el índice de `(`, `{` o `[`, devuelve el índice de su cierre correspondiente
 * (o -1 si no está balanceado). Asume que los comentarios ya fueron eliminados.
 */
export function findMatching(code: string, openIndex: number): number {
  const open = code[openIndex];
  const close = PAIRS[open];
  if (!close) return -1;

  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const char = code[i];
    if (i > openIndex && isLiteralStart(code, i)) {
      i = skipLiteral(code, i);
      continue;
    }
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Divide `content` por `separator` solo en el nivel superior (fuera de paréntesis, llaves, corchetes y strings). */
export function splitTopLevel(content: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (isLiteralStart(content, i)) {
      const end = skipLiteral(content, i);
      current += content.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') depth++;
    else if (char === ')' || char === '}' || char === ']') depth--;

    if (char === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Devuelve el valor de un literal string (`'x'`, `"x"` o `` `x` `` sin interpolación), o `null`. */
export function parseStringLiteral(text: string): string | null {
  const match = text.trim().match(/^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/s);
  if (!match) return null;
  if (match[1] === '`' && match[2].includes('${')) return null;
  return match[2].replace(/\\(.)/g, '$1');
}

/**
 * Convierte un literal JS simple (string, número, booleano, null, array u objeto
 * con claves simples) en un valor. Devuelve `undefined` si no es estático.
 */
export function parseLiteralValue(text: string): unknown {
  const trimmed = text.trim();
  const str = parseStringLiteral(trimmed);
  if (str !== null) return str;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;

  if (trimmed.startsWith('[') && findMatching(trimmed, 0) === trimmed.length - 1) {
    const items = splitTopLevel(trimmed.slice(1, -1)).map(parseLiteralValue);
    return items.some((item) => item === undefined) ? undefined : items;
  }

  if (trimmed.startsWith('{') && findMatching(trimmed, 0) === trimmed.length - 1) {
    const result: Record<string, unknown> = {};
    for (const prop of splitTopLevel(trimmed.slice(1, -1))) {
      const colon = prop.indexOf(':');
      if (colon === -1) return undefined;
      const key = parseStringLiteral(prop.slice(0, colon)) ?? prop.slice(0, colon).trim();
      const value = parseLiteralValue(prop.slice(colon + 1));
      if (value === undefined) return undefined;
      result[key] = value;
    }
    return result;
  }

  return undefined;
}

/** Salta espacios desde `index` y devuelve el primer índice no vacío. */
export function skipWhitespace(code: string, index: number): number {
  let i = index;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Salta una anotación de tipo de retorno (`: Promise<{ ok: boolean }>`) que empieza en `index`
 * y devuelve el índice del primer carácter después de ella.
 */
function skipReturnType(code: string, index: number): number {
  let i = skipWhitespace(code, index);
  if (code[i] !== ':') return i;
  i++;
  let angle = 0;
  for (; i < code.length; i++) {
    const char = code[i];
    if (char === '<') angle++;
    else if (char === '>' && code[i - 1] !== '=') angle--;
    else if (angle === 0 && (char === '{' || (char === '=' && code[i + 1] === '>'))) return i;
    else if (char === '(' || char === '[' || (char === '{' && angle > 0)) {
      const end = findMatching(code, i);
      if (end === -1) return code.length;
      i = end;
    }
  }
  return i;
}

/**
 * Extrae el cuerpo de una función que empieza con su lista de parámetros en `parenIndex`.
 * Soporta funciones normales (`(...) {}`) y flechas (`(...) => {}` o `(...) => expr`).
 */
function extractBodyAfterParams(code: string, parenIndex: number): string | null {
  const paramsEnd = findMatching(code, parenIndex);
  if (paramsEnd === -1) return null;

  let i = skipReturnType(code, paramsEnd + 1);
  i = skipWhitespace(code, i);
  if (code[i] === '=' && code[i + 1] === '>') {
    i = skipWhitespace(code, i + 2);
  }

  if (code[i] === '{') {
    const end = findMatching(code, i);
    return end === -1 ? null : code.slice(i, end + 1);
  }

  // Flecha con expresión: tomar hasta el fin de la sentencia en el nivel superior.
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const char = code[j];
    if (isLiteralStart(code, j)) { j = skipLiteral(code, j); continue; }
    if (char === '(' || char === '{' || char === '[') depth++;
    else if (char === ')' || char === '}' || char === ']') {
      if (depth === 0) return code.slice(i, j);
      depth--;
    } else if ((char === ';' || char === '\n') && depth === 0) {
      return code.slice(i, j);
    }
  }
  return code.slice(i);
}

/**
 * Busca la función `name` (declaración, `const name = ...` con flecha/función,
 * o envuelta como `const name = withAuth(async (req) => {...})`) y devuelve su cuerpo.
 * Si `name` es un alias de otro identificador (`const GET = handler`), lo resuelve.
 */
export function findFunctionBody(code: string, name: string, depth = 0): string | null {
  if (depth > 3) return null;
  const escaped = escapeRegExp(name);

  const declaration = new RegExp(`(?:^|[^\\w$.])(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\s*(?:<[^>]*>)?\\s*\\(`, 'm');
  const declMatch = declaration.exec(code);
  if (declMatch) {
    const parenIndex = declMatch.index + declMatch[0].length - 1;
    return extractBodyAfterParams(code, parenIndex);
  }

  const assignment = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=(?!=)`, 'm');
  const assignMatch = assignment.exec(code);
  if (!assignMatch) return null;

  let i = skipWhitespace(code, assignMatch.index + assignMatch[0].length);
  if (code.startsWith('async', i) && !/[\w$]/.test(code[i + 5] ?? '')) {
    i = skipWhitespace(code, i + 5);
  }

  if (code.startsWith('function', i)) {
    const paren = code.indexOf('(', i);
    return paren === -1 ? null : extractBodyAfterParams(code, paren);
  }

  if (code[i] === '(') {
    return extractBodyAfterParams(code, i);
  }

  // Parámetro único sin paréntesis: `req => {...}`
  const singleParam = /^[\w$]+\s*=>/.exec(code.slice(i));
  if (singleParam) {
    const arrow = code.indexOf('=>', i);
    const bodyStart = skipWhitespace(code, arrow + 2);
    if (code[bodyStart] === '{') {
      const end = findMatching(code, bodyStart);
      return end === -1 ? null : code.slice(bodyStart, end + 1);
    }
    return extractBodyAfterParams(`()${code.slice(arrow)}`, 0);
  }

  // Envoltorio: `withAuth(async (req) => {...})` -> usar el contenido de la llamada.
  const call = /^[\w$.]+\s*(?:<[^>]*>)?\s*\(/.exec(code.slice(i));
  if (call) {
    const paren = i + call[0].length - 1;
    const end = findMatching(code, paren);
    return end === -1 ? null : code.slice(paren + 1, end);
  }

  // Alias: `const GET = handler;`
  const alias = /^([\w$]+)\s*;?/.exec(code.slice(i));
  if (alias && alias[1] !== name) {
    return findFunctionBody(code, alias[1], depth + 1);
  }

  return null;
}

export interface ImportBinding {
  /** Nombre exportado en el módulo de origen (`default` para imports por defecto). */
  imported: string;
  specifier: string;
}

/** Mapea nombres locales importados a su origen: `import { a as b } from './x'` -> `b -> { imported: 'a', specifier: './x' }`. */
export function parseImports(code: string): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const importRegex = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;

  for (const match of code.matchAll(importRegex)) {
    const clause = match[1].trim();
    const specifier = match[3];

    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const cleaned = part.trim().replace(/^type\s+/, '');
        if (!cleaned) continue;
        const [imported, local] = cleaned.split(/\s+as\s+/).map((s) => s.trim());
        bindings.set(local ?? imported, { imported, specifier });
      }
    }

    const defaultName = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, '').trim();
    if (defaultName && /^[\w$]+$/.test(defaultName)) {
      bindings.set(defaultName, { imported: 'default', specifier });
    }
  }

  return bindings;
}

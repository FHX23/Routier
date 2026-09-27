import type { BodyContentType, JsonSchema } from '../../types.js';
import { findFunction, findMatching, parseImports, parseLiteralValue, resolveExportedLocal, skipWhitespace, splitTopLevel, type FunctionInfo } from './code.js';
import { readTypeExpression, typeTextToSchema } from './classes.js';
import type { SourceLoader } from './source.js';
import { resolveSchemaByName } from './zod.js';

/**
 * Rastreo estático de un valor de la request (el body o la query) dentro de un handler:
 * qué campos se leen, con qué tipo se declara, qué schema lo valida y a qué funciones se
 * pasa (siguiendo imports hasta dos niveles). No ejecuta código.
 */

const MAX_DEPTH = 2;

/** Métodos y propiedades de strings/arrays/objetos que no son campos del body. */
const NOT_FIELDS = new Set([
  'length', 'map', 'filter', 'forEach', 'reduce', 'some', 'every', 'find', 'findIndex', 'includes', 'indexOf', 'slice',
  'splice', 'concat', 'join', 'push', 'pop', 'shift', 'sort', 'flat', 'flatMap', 'keys', 'values', 'entries', 'trim',
  'toLowerCase', 'toUpperCase', 'split', 'replace', 'startsWith', 'endsWith', 'toString', 'valueOf', 'toFixed', 'at',
  'then', 'catch', 'get', 'getAll', 'has', 'set', 'append', 'delete', 'constructor', 'hasOwnProperty',
]);

const PARSE_METHODS = 'safeParse|parse|parseAsync|safeParseAsync|validate|validateAsync|assert|cast';

export interface FlowContext {
  filePath: string;
  loader: SourceLoader;
}

interface Root {
  /** Expresión que representa el valor (`body`, `req.body`, `req.body.article`). */
  expr: string;
  /** Ruta dentro del valor rastreado (`['article']`). */
  path: string[];
}

/** Árbol de evidencia: campos leídos y schemas/tipos encontrados en cada ruta. */
interface FieldNode {
  children: Map<string, FieldNode>;
  schema?: JsonSchema;
  source?: 'schema' | 'type';
  defaultValue?: unknown;
}

const newNode = (): FieldNode => ({ children: new Map() });

function nodeAt(root: FieldNode, path: string[]): FieldNode {
  let node = root;
  for (const key of path) {
    let child = node.children.get(key);
    if (!child) {
      child = newNode();
      node.children.set(key, child);
    }
    node = child;
  }
  return node;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\??\\.\\s*');
}

/** Identificador corto de un fragmento de código (hash FNV-1a). */
function codeId(code: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${code.length}:${(hash >>> 0).toString(36)}`;
}

/** El valor termina ahí (no es `expr.campo` ni `expr(...)`). */
const END = String.raw`(?=\s*\)?\s*(?:as\b|[;\n,)}]|$))`;

/** Lee la anotación `as T` que empieza en `index` (acepta `)` antes y tipos objeto multilínea). */
function readAsType(code: string, index: number): string | undefined {
  let i = skipWhitespace(code, index);
  if (code[i] === ')') i = skipWhitespace(code, i + 1);
  if (!/^as\s/.test(code.slice(i, i + 3))) return undefined;
  i = skipWhitespace(code, i + 2);
  if (code[i] === '{') {
    const end = findMatching(code, i);
    return end === -1 ? undefined : code.slice(i, end + 1);
  }
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const char = code[j];
    if ('<([{'.includes(char)) depth++;
    else if ('>)]}'.includes(char)) {
      if (depth === 0) return code.slice(i, j);
      depth--;
    } else if (depth === 0 && (char === ';' || char === '\n' || char === ',')) {
      return code.slice(i, j);
    }
  }
  return code.slice(i);
}

function setSchema(node: FieldNode, schema: JsonSchema, source: 'schema' | 'type') {
  // Una validación explícita gana sobre una anotación de tipo.
  if (node.schema && node.source === 'schema' && source === 'type') return;
  if (!schema.type && !schema.properties && !schema.anyOf && !schema.enum) return;
  node.schema = schema;
  node.source = source;
}

async function schemaFromType(type: string, ctx: FlowContext): Promise<JsonSchema | null> {
  const result = await typeTextToSchema(type, { filePath: ctx.filePath, loader: ctx.loader, depth: 0 });
  const schema = result.schema;
  return schema.type || schema.properties || schema.enum || schema.anyOf ? schema : null;
}

/** Resuelve la función llamada (`fn`, `obj.fn`, `this.service.fn`) a sus parámetros y cuerpo. */
async function resolveCallee(callee: string, _snippet: string, ctx: FlowContext): Promise<(FunctionInfo & { filePath: string }) | null> {
  const parts = callee.split('.').map((part) => part.trim()).filter(Boolean);
  const name = parts[parts.length - 1];
  if (!name || NOT_FIELDS.has(name) || ['JSON', 'Object', 'Array', 'console', 'Number', 'String', 'Boolean', 'Math', 'Date', 'Promise'].includes(parts[0])) return null;
  // Imports, funciones locales y propiedades del constructor se buscan en el archivo completo.
  const code = (await ctx.loader.load(ctx.filePath)) ?? _snippet;

  // this.service.method(...) (NestJS): tipo de la propiedad declarada en el constructor.
  if (parts[0] === 'this' && parts.length === 3) {
    const property = parts[1].replace(/\$/g, '\\$');
    const typeMatch = new RegExp(`(?:private|public|protected|readonly)\\s+(?:readonly\\s+)?${property}\\s*:\\s*([\\w$]+)`).exec(code)
      ?? new RegExp(`\\b${property}\\s*[!?]?\\s*:\\s*([\\w$]+)`).exec(code);
    if (!typeMatch) return null;
    return resolveImported(typeMatch[1], name, code, ctx);
  }

  if (parts.length === 1) {
    const local = findFunction(code, name);
    if (local) return { ...local, filePath: ctx.filePath };
    return resolveImported(name, null, code, ctx);
  }
  // objeto.metodo(...): objeto importado (namespace, default con métodos o instancia de clase importada)
  const local = findFunction(code, name);
  if (local && parts.length === 2 && !parseImports(code).has(parts[0])) return { ...local, filePath: ctx.filePath };
  const instance = new RegExp(`(?:const|let|var)\\s+${parts[0].replace(/\$/g, '\\$')}\\s*=\\s*new\\s+([\\w$]+)`).exec(code);
  return resolveImported(instance?.[1] ?? parts[0], name, code, ctx);
}

async function resolveImported(importName: string, member: string | null, code: string, ctx: FlowContext): Promise<(FunctionInfo & { filePath: string }) | null> {
  const binding = parseImports(code).get(importName);
  if (!binding) return null;
  const target = ctx.loader.resolve(ctx.filePath, binding.specifier);
  const targetCode = target ? await ctx.loader.load(target) : null;
  if (!target || !targetCode) return null;
  let name = member;
  if (!name) {
    name = binding.imported === 'default' ? resolveExportedLocal(targetCode, 'default') : binding.imported;
  }
  if (!name) return null;
  const fn = findFunction(targetCode, name);
  return fn ? { ...fn, filePath: target } : null;
}

/** Busca las llamadas en las que `expr` se pasa como argumento directo: `fn(a, expr)`. */
function callsWithArgument(code: string, expr: string): { callee: string; index: number; spread: boolean }[] {
  const calls: { callee: string; index: number; spread: boolean }[] = [];
  // `fn(expr)`, `fn(a, ...expr)` y `fn({ ...expr, extra })` (el body esparcido en un objeto).
  const pattern = new RegExp(`[(,]\\s*(?:(\\.\\.\\.)?${escape(expr)}\\s*(?=[,)])|\\{\\s*\\.\\.\\.${escape(expr)}\\s*(?=[,}]))`, 'g');
  for (const match of code.matchAll(pattern)) {
    // Retroceder hasta el paréntesis de apertura de la llamada.
    let depth = 0;
    let open = -1;
    for (let i = match.index!; i >= 0; i--) {
      const char = code[i];
      if (char === ')' || char === ']' || char === '}') depth++;
      else if (char === '(' || char === '[' || char === '{') {
        if (depth === 0) { open = i; break; }
        depth--;
      }
    }
    if (open === -1 || code[open] !== '(') continue;
    const before = code.slice(Math.max(0, open - 200), open);
    const calleeMatch = /((?:this\s*\.\s*)?[\w$]+(?:\s*\.\s*[\w$]+)*)\s*(?:<[^<>]*>)?\s*$/.exec(before);
    if (!calleeMatch) continue;
    const callee = calleeMatch[1].replace(/\s+/g, '');
    if (/^(if|for|while|switch|return|await|typeof|catch|function)$/.test(callee)) continue;
    const close = findMatching(code, open);
    if (close === -1) continue;
    const args = splitTopLevel(code.slice(open + 1, close));
    const target = expr.replace(/\s+/g, '');
    const index = args.findIndex((arg) => {
      const compact = arg.replace(/\s+/g, '');
      return compact.replace(/^\.\.\./, '') === target || compact.startsWith(`{...${target},`) || compact === `{...${target}}`;
    });
    if (index === -1) continue;
    calls.push({ callee, index, spread: Boolean(match[1]) });
  }
  return calls;
}

async function collect(code: string, roots: Root[], tree: FieldNode, ctx: FlowContext, depth: number, seen: Set<string>) {
  const queue = [...roots];
  while (queue.length > 0) {
    const root = queue.shift()!;
    // Dos funciones del mismo archivo pueden llamar igual a su parámetro: la clave incluye el fragmento.
    const key = `${ctx.filePath}|${codeId(code)}|${root.expr}|${root.path.join('.')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const expr = escape(root.expr);
    const here = nodeAt(tree, root.path);

    // Alias y variables tipadas: const data = <expr>; const data: T = <expr>; const data = <expr> as T
    for (const match of code.matchAll(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*(?::\\s*([^=;]+?))?\\s*=\\s*\\(?\\s*${expr}${END}`, 'g'))) {
      const type = (match[2] ?? readAsType(code, match.index! + match[0].length))?.trim();
      if (type && type !== 'any' && type !== 'unknown') {
        const schema = await schemaFromType(type, ctx);
        if (schema) setSchema(here, schema, 'type');
      }
      queue.push({ expr: match[1], path: root.path });
    }
    // const data = { ...expr, extra } -> data contiene los campos del valor rastreado
    for (const match of code.matchAll(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*(?::[^=]+)?=\\s*\\{\\s*\\.\\.\\.${expr}\\s*[,}]`, 'g'))) {
      queue.push({ expr: match[1], path: root.path });
    }

    // (expr as T) en línea
    for (const match of code.matchAll(new RegExp(`${expr}(?=\\s*\\)?\\s*as\\s)`, 'g'))) {
      const type = readAsType(code, match.index! + match[0].length)?.trim();
      if (!type || type === 'any' || type === 'unknown' || type === 'const') continue;
      const schema = await schemaFromType(type, ctx);
      if (schema) setSchema(here, schema, 'type');
    }

    // Destructuring: const { a, b: c, d = 1 } = expr
    for (const match of code.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*(?::\\s*([^=]+?))?\\s*=\\s*\\(?\\s*${expr}${END}`, 'g'))) {
      for (const part of splitTopLevel(match[1])) {
        const [binding, defaultText] = part.split('=').map((s) => s.trim());
        const field = binding.split(':')[0].trim().replace(/^\.\.\./, '');
        if (!/^[\w$]+$/.test(field) || part.trim().startsWith('...')) continue;
        const child = nodeAt(here, [field]);
        if (defaultText !== undefined) {
          const value = parseLiteralValue(defaultText);
          if (value !== undefined) child.defaultValue = value;
        }
        const alias = binding.includes(':') ? binding.split(':')[1].trim() : field;
        if (/^[\w$]+$/.test(alias)) queue.push({ expr: alias, path: [...root.path, field] });
      }
      const type = (match[2] ?? readAsType(code, match.index! + match[0].length))?.trim();
      if (type) {
        const schema = await schemaFromType(type, ctx);
        if (schema) setSchema(here, schema, 'type');
      }
    }

    // Accesos: expr.a, expr?.a, expr['a'], expr.a.b
    // Precedido por algo que no sea identificador ni acceso a miembro (se permite el spread `...expr`).
    for (const match of code.matchAll(new RegExp(`(?<=^|[^\\w$.]|\\.\\.\\.)${expr}((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*|\\s*\\[\\s*['"\`][\\w$-]+['"\`]\\s*\\])+)(\\s*\\()?`, 'g'))) {
      const chain = [...match[1].matchAll(/[A-Za-z_$][\w$]*|['"`]([\w$-]+)['"`]/g)].map((m) => m[1] ?? m[0]);
      if (match[2]) chain.pop(); // el último elemento es un método llamado
      const fields: string[] = [];
      for (const part of chain) {
        if (NOT_FIELDS.has(part)) break;
        fields.push(part);
      }
      if (fields.length > 0) {
        const child = nodeAt(here, fields);
        // `body.role as UserRole`: el tipo del cast describe el campo (p. ej. una unión de literales).
        if (!match[2]) {
          const cast = readAsType(code, match.index! + match[0].length)?.trim();
          if (cast && !['any', 'unknown', 'string', 'number', 'boolean', 'const'].includes(cast)) {
            const schema = await schemaFromType(cast, ctx);
            if (schema) setSchema(child, schema, 'type');
          }
        }
        // `req.body.article` también se rastrea (alias, llamadas a servicios, spreads).
        if (fields.length <= 2 && root.path.length < 3) {
          queue.push({ expr: `${root.expr}.${fields.join('.')}`, path: [...root.path, ...fields] });
        }
      }
    }

    // Validación: schema.parse(expr) / schema.safeParse({ ...expr, id })
    for (const match of code.matchAll(new RegExp(`([\\w$]+)\\s*\\.\\s*(?:${PARSE_METHODS})\\s*\\(\\s*(?:\\{\\s*\\.\\.\\.\\s*)?${expr}\\s*[,)}]`, 'g'))) {
      if (['JSON', 'Number', 'Date'].includes(match[1])) continue;
      const schema = await resolveSchemaByName(match[1], ctx.filePath, ctx.loader);
      if (schema) setSchema(here, schema, 'schema');
    }

    // Funciones que reciben el valor: seguir hasta MAX_DEPTH niveles.
    if (depth < MAX_DEPTH) {
      for (const call of callsWithArgument(code, root.expr)) {
        const fn = await resolveCallee(call.callee, code, ctx);
        const param = fn?.params[call.index];
        if (!fn || !param) continue;
        const next = { filePath: fn.filePath, loader: ctx.loader };
        if (param.type) {
          const schema = await schemaFromType(param.type, next);
          if (schema) setSchema(here, schema, 'type');
        }
        if (param.keys) for (const field of param.keys) nodeAt(here, [field]);
        if (param.name) await collect(fn.body, [{ expr: param.name, path: root.path }], tree, next, depth + 1, seen);
      }
    }
  }
}

function toSchema(node: FieldNode): JsonSchema {
  if (node.schema && node.children.size === 0) return node.schema;
  if (node.schema?.properties) {
    // El schema declarado manda; los campos leídos que no estén se agregan.
    const properties = { ...node.schema.properties };
    for (const [key, child] of node.children) {
      if (!properties[key]) properties[key] = toSchema(child);
    }
    return { ...node.schema, properties };
  }
  if (node.children.size === 0) {
    if (node.defaultValue !== undefined) {
      const type = typeof node.defaultValue;
      if (type === 'boolean' || type === 'string') return { type, default: node.defaultValue };
      if (type === 'number') return { type: 'number', default: node.defaultValue };
    }
    return {};
  }
  return {
    type: 'object',
    properties: Object.fromEntries([...node.children].map(([key, child]) => [key, toSchema(child)])),
  };
}

export interface TrackedValue {
  schema: JsonSchema;
  /** `schema`: validado (Zod/Joi/TypeBox); `type`: anotación TS; `usage`: campos leídos en el código. */
  source: 'schema' | 'type' | 'usage';
}

/** Rastrea `roots` en `code` y devuelve el schema del valor, o `null` si no hay evidencia. */
export async function trackValue(code: string, roots: Root[], ctx: FlowContext): Promise<TrackedValue | null> {
  const tree = newNode();
  await collect(code, roots, tree, ctx, 0, new Set());
  if (!tree.schema && tree.children.size === 0) return null;
  const schema = toSchema(tree);
  if (!schema.properties && !schema.type && !schema.anyOf) return null;
  return { schema, source: tree.source ?? 'usage' };
}

export interface RequestBodyInference {
  contentType: BodyContentType;
  schema?: JsonSchema;
  source?: TrackedValue['source'];
}

const FILE_FIELD = /file|image|photo|picture|avatar|logo|attachment|document|upload/i;

/** Campos de un FormData: form.get('x'), form.getAll('x'), siguiendo la variable a otras funciones. */
async function trackFormData(code: string, variable: string, ctx: FlowContext, depth = 0): Promise<Record<string, JsonSchema>> {
  const fields: Record<string, JsonSchema> = {};
  const expr = escape(variable);
  for (const match of code.matchAll(new RegExp(`${expr}\\s*\\.\\s*(get|getAll|has)\\s*\\(\\s*['"\`]([\\w$.-]+)['"\`]\\s*\\)(\\s*as\\s+([\\w$]+))?`, 'g'))) {
    const isFile = match[4] === 'File' || match[4] === 'Blob' || FILE_FIELD.test(match[2]);
    const item: JsonSchema = isFile ? { type: 'string', format: 'binary' } : { type: 'string' };
    // `(form.get('folder') as string) || 'products'`: el valor por defecto es un buen ejemplo.
    const fallback = /^\s*\)?\s*(?:\|\||\?\?)\s*(['"`])([^'"`]*)\1/.exec(code.slice(match.index! + match[0].length));
    if (!isFile && fallback) item.default = fallback[2];
    fields[match[2]] = match[1] === 'getAll' ? { type: 'array', items: item } : item;
  }
  if (depth < MAX_DEPTH) {
    for (const call of callsWithArgument(code, variable)) {
      const fn = await resolveCallee(call.callee, code, ctx);
      const param = fn?.params[call.index];
      if (fn?.body && param?.name) Object.assign(fields, await trackFormData(fn.body, param.name, { filePath: fn.filePath, loader: ctx.loader }, depth + 1));
    }
  }
  return fields;
}

/**
 * Infere el body de un handler estilo Fetch API (`await req.json()`, `formData()`, `text()`).
 */
export async function inferFetchBody(handlerBody: string, ctx: FlowContext): Promise<RequestBodyInference | null> {
  const read = /await\s+([\w$]+)\s*\.\s*(json|formData|text)\s*\(\s*\)/.exec(handlerBody);
  if (!read) return null;
  const [, , kind] = read;

  if (kind === 'text') return { contentType: 'text/plain' };

  if (kind === 'formData') {
    const binding = new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*(?::[^=]+)?=\\s*${escape(read[0])}`).exec(handlerBody);
    const fields = binding ? await trackFormData(handlerBody, binding[1], ctx) : {};
    return {
      contentType: 'multipart/form-data',
      schema: { type: 'object', properties: fields },
      source: 'usage',
    };
  }

  // JSON: el valor se rastrea desde la expresión `await req.json()` (más sus alias).
  const roots: Root[] = [{ expr: read[0], path: [] }];
  // `let body: T; body = await req.json()`
  const assigned = new RegExp(`(?<![\\w$.])([\\w$]+)\\s*=\\s*${escape(read[0])}`).exec(handlerBody);
  if (assigned) {
    roots.push({ expr: assigned[1], path: [] });
    const declared = new RegExp(`(?:let|var)\\s+${assigned[1]}\\s*:\\s*`).exec(handlerBody);
    if (declared) {
      const type = readTypeExpression(handlerBody, declared.index + declared[0].length).replace(/\s*=[\s\S]*$/, '');
      const schema = await schemaFromType(type.trim(), ctx);
      if (schema) {
        // Casts posteriores sobre los campos (`body.role as Role`) afinan el tipo declarado.
        const tracked = await trackValue(handlerBody, roots, ctx);
        const refined = Object.entries(tracked?.schema.properties ?? {}).filter(([, value]) => value.enum);
        if (refined.length > 0) schema.properties = { ...schema.properties, ...Object.fromEntries(refined) };
        return { contentType: 'application/json', schema, source: 'type' };
      }
    }
  }
  const tracked = await trackValue(handlerBody, roots, ctx);
  return { contentType: 'application/json', schema: tracked?.schema, source: tracked?.source };
}

/**
 * Infere el body de un handler estilo Node (`req.body` en Express, Fastify y Pages Router).
 * `requestNames` son los nombres posibles del objeto request en el handler.
 */
export async function inferNodeBody(handlerBody: string, requestNames: string[], ctx: FlowContext): Promise<RequestBodyInference | null> {
  const roots = requestNames.map((name) => ({ expr: `${name}.body`, path: [] as string[] }));
  const tracked = await trackValue(handlerBody, roots, ctx);
  if (!tracked) return null;
  return { contentType: 'application/json', schema: tracked.schema, source: tracked.source };
}

/** Campos de query leídos a través de un valor rastreado (`req.query` pasado a un servicio, `@Query() q`). */
export async function inferTrackedQuery(handlerBody: string, roots: Root[], ctx: FlowContext): Promise<string[]> {
  const tracked = await trackValue(handlerBody, roots, ctx);
  return Object.keys(tracked?.schema.properties ?? {});
}

/** Primer parámetro de una función flecha o declaración en línea (`async (req, res) =>`). */
export function firstParamName(fnText: string): string | null {
  let i = skipWhitespace(fnText, 0);
  if (fnText.startsWith('async', i)) i = skipWhitespace(fnText, i + 5);
  if (fnText.startsWith('function', i)) i = fnText.indexOf('(', i);
  if (fnText[i] === '(') {
    const close = findMatching(fnText, i);
    const first = splitTopLevel(fnText.slice(i + 1, close))[0] ?? '';
    const name = /^\s*([\w$]+)/.exec(first);
    return name ? name[1] : null;
  }
  const single = /^([\w$]+)\s*=>/.exec(fnText.slice(i));
  return single ? single[1] : null;
}

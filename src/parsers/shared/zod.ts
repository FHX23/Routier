import type { JsonSchema } from '../../types.js';
import { findMatching, parseImports, parseLiteralValue, parseStringLiteral, skipWhitespace, splitTopLevel } from './code.js';
import type { SourceLoader } from './source.js';

/**
 * Intérprete estático de schemas Zod (v3 y v4). No ejecuta código: lee las
 * declaraciones `const x = z.object({...})` (en el mismo archivo o importadas)
 * y las traduce a JSON Schema para generar ejemplos y documentación.
 */

const MAX_DEPTH = 6;

const STRING_FORMATS: Record<string, string> = {
  email: 'email',
  uuid: 'uuid',
  guid: 'uuid',
  url: 'uri',
  httpUrl: 'uri',
  datetime: 'date-time',
  date: 'date',
  time: 'time',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
  cuid: 'cuid',
  cuid2: 'cuid2',
  ulid: 'ulid',
  nanoid: 'nanoid',
  jwt: 'jwt',
  e164: 'e164',
  base64: 'byte',
};

const IGNORED_RECEIVERS = new Set(['JSON', 'Date', 'Number', 'Math', 'URL', 'Intl', 'BigInt']);

interface Segment {
  name: string;
  args: string | null;
}

interface Interpreted {
  schema: JsonSchema;
  optional: boolean;
}

interface Context {
  filePath: string;
  loader: SourceLoader;
  depth: number;
}

function parseChain(expression: string): Segment[] | null {
  const code = expression.trim();
  const segments: Segment[] = [];
  let i = 0;

  while (i < code.length) {
    i = skipWhitespace(code, i);
    const ident = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
    if (!ident) break;
    i += ident[0].length;
    let j = skipWhitespace(code, i);

    // Genéricos: z.custom<Foo>()
    if (code[j] === '<') {
      const close = code.indexOf('>', j);
      if (close !== -1 && code[skipWhitespace(code, close + 1)] === '(') j = skipWhitespace(code, close + 1);
    }

    let args: string | null = null;
    if (code[j] === '(') {
      const end = findMatching(code, j);
      if (end === -1) return null;
      args = code.slice(j + 1, end);
      i = end + 1;
    }
    segments.push({ name: ident[0], args });

    j = skipWhitespace(code, i);
    if (code[j] === '?' && code[j + 1] === '.') j++;
    if (code[j] !== '.') break;
    i = j + 1;
  }

  return segments.length > 0 ? segments : null;
}

function literalSchema(value: unknown): JsonSchema {
  const type = typeof value;
  if (type === 'string') return { type: 'string', enum: [value] };
  if (type === 'number') return { type: 'number', enum: [value] };
  if (type === 'boolean') return { type: 'boolean', enum: [value] };
  return { enum: [value] };
}

function markOptional(result: Interpreted): Interpreted {
  return { ...result, optional: true };
}

async function interpretBase(segment: Segment, ctx: Context): Promise<Interpreted | null> {
  const args = segment.args ?? '';
  const plain = (schema: JsonSchema): Interpreted => ({ schema, optional: false });

  switch (segment.name) {
    case 'string':
      return plain({ type: 'string' });
    case 'number':
      return plain({ type: 'number' });
    case 'int':
    case 'int32':
    case 'bigint':
      return plain({ type: 'integer' });
    case 'boolean':
      return plain({ type: 'boolean' });
    case 'date':
      return plain({ type: 'string', format: 'date-time' });
    case 'literal': {
      const value = parseLiteralValue(args);
      return plain(value === undefined ? {} : literalSchema(value));
    }
    case 'enum': {
      const value = parseLiteralValue(args);
      if (Array.isArray(value)) return plain({ type: 'string', enum: value });
      if (value && typeof value === 'object') return plain({ type: 'string', enum: Object.values(value) });
      return plain({ type: 'string' });
    }
    case 'nativeEnum':
      return plain({ type: 'string' });
    case 'object':
    case 'strictObject':
    case 'looseObject': {
      const shape = args.trim();
      return plain(shape.startsWith('{') ? await interpretShape(shape, ctx) : { type: 'object' });
    }
    case 'array':
    case 'set': {
      const inner = await interpretExpression(splitTopLevel(args)[0] ?? '', ctx);
      return plain({ type: 'array', items: inner?.schema ?? {} });
    }
    case 'record':
    case 'map': {
      const parts = splitTopLevel(args);
      const value = await interpretExpression(parts[parts.length - 1] ?? '', ctx);
      return plain({ type: 'object', additionalProperties: value?.schema ?? {} });
    }
    case 'tuple': {
      const list = args.trim();
      const first = list.startsWith('[') ? splitTopLevel(list.slice(1, -1))[0] : undefined;
      const inner = first ? await interpretExpression(first, ctx) : null;
      return plain({ type: 'array', items: inner?.schema ?? {} });
    }
    case 'union':
    case 'discriminatedUnion': {
      const parts = splitTopLevel(args);
      const list = parts[parts.length - 1]?.trim() ?? '';
      if (!list.startsWith('[')) return plain({});
      const options = await Promise.all(splitTopLevel(list.slice(1, -1)).map((item) => interpretExpression(item, ctx)));
      const schemas = options.filter((o): o is Interpreted => o !== null).map((o) => o.schema);
      return plain(schemas.length > 0 ? { anyOf: schemas } : {});
    }
    case 'optional':
    case 'nullish': {
      const inner = await interpretExpression(args, ctx);
      return inner ? markOptional(inner) : null;
    }
    case 'nullable': {
      const inner = await interpretExpression(args, ctx);
      return inner ? { schema: { ...inner.schema, nullable: true }, optional: inner.optional } : null;
    }
    case 'any':
    case 'unknown':
    case 'lazy':
    case 'custom':
    case 'instanceof':
      return plain({});
    default: {
      const format = STRING_FORMATS[segment.name];
      if (format) return plain({ type: 'string', format });
      return null;
    }
  }
}

async function applyModifier(current: Interpreted, segment: Segment, ctx: Context): Promise<Interpreted> {
  const args = segment.args ?? '';
  const { schema } = current;

  switch (segment.name) {
    case 'optional':
    case 'nullish':
      return markOptional(current);
    case 'nullable':
      return { ...current, schema: { ...schema, nullable: true } };
    case 'default':
    case 'catch':
    case 'prefault': {
      const value = parseLiteralValue(args);
      return { schema: value === undefined ? schema : { ...schema, default: value }, optional: true };
    }
    case 'int':
      return { ...current, schema: { ...schema, type: 'integer' } };
    case 'array':
      return { ...current, schema: { type: 'array', items: schema } };
    case 'or': {
      const other = await interpretExpression(args, ctx);
      return other ? { ...current, schema: { anyOf: [schema, other.schema] } } : current;
    }
    case 'extend':
    case 'safeExtend':
    case 'merge':
    case 'and': {
      const trimmed = args.trim();
      const extra = trimmed.startsWith('{')
        ? await interpretShape(trimmed, ctx)
        : (await interpretExpression(trimmed, ctx))?.schema;
      return extra ? { ...current, schema: mergeObjects(schema, extra) } : current;
    }
    case 'partial':
      return { ...current, schema: { ...schema, required: undefined } };
    case 'required':
      return { ...current, schema: { ...schema, required: Object.keys(schema.properties ?? {}) } };
    case 'pick':
    case 'omit': {
      const mask = parseLiteralValue(args);
      if (!mask || typeof mask !== 'object' || !schema.properties) return current;
      const keys = new Set(Object.keys(mask));
      const keep = (key: string) => (segment.name === 'pick' ? keys.has(key) : !keys.has(key));
      const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => keep(key)));
      const required = schema.required?.filter(keep);
      return { ...current, schema: { ...schema, properties, required: required?.length ? required : undefined } };
    }
    default: {
      const format = STRING_FORMATS[segment.name];
      if (format && schema.type === 'string') {
        return { ...current, schema: { ...schema, format } };
      }
      // min, max, length, regex, trim, describe, refine, transform, brand, strict... no cambian la forma.
      return current;
    }
  }
}

function mergeObjects(base: JsonSchema, extra: JsonSchema): JsonSchema {
  const required = [...(base.required ?? []), ...(extra.required ?? [])];
  return {
    ...base,
    type: 'object',
    properties: { ...base.properties, ...extra.properties },
    required: required.length > 0 ? [...new Set(required)] : undefined,
  };
}

async function interpretShape(block: string, ctx: Context): Promise<JsonSchema> {
  const inner = block.trim().replace(/^\{/, '').replace(/\}$/, '');
  let result: JsonSchema = { type: 'object', properties: {} };
  const required: string[] = [];

  for (const prop of splitTopLevel(inner)) {
    if (prop.startsWith('...')) {
      const ref = prop.slice(3).trim().replace(/\.shape$/, '');
      const spread = (await interpretExpression(ref, ctx))?.schema;
      if (spread) result = mergeObjects(result, spread);
      continue;
    }

    const colon = findTopLevelColon(prop);
    const rawKey = colon === -1 ? prop : prop.slice(0, colon);
    const key = parseStringLiteral(rawKey) ?? rawKey.trim();
    const valueText = colon === -1 ? prop : prop.slice(colon + 1);
    if (!/^[\w$-]+$/.test(key)) continue;

    const value = await interpretExpression(valueText, ctx);
    result.properties![key] = value?.schema ?? {};
    if (!value?.optional) required.push(key);
  }

  const allRequired = [...(result.required ?? []), ...required];
  result.required = allRequired.length > 0 ? [...new Set(allRequired)] : undefined;
  return result;
}

function findTopLevelColon(text: string): number {
  const literal = /^\s*(['"`])(?:\\.|(?!\1)[^\\])*\1\s*:/.exec(text);
  if (literal) return literal[0].length - 1;
  return text.search(/:/);
}

/** Interpreta una expresión Zod (`z.string().email()`, `userSchema.optional()`, etc.). */
export async function interpretExpression(expression: string, ctx: Context): Promise<Interpreted | null> {
  if (ctx.depth > MAX_DEPTH) return null;
  const segments = parseChain(expression);
  if (!segments) return null;

  let index = 0;
  let current: Interpreted | null = null;
  const next = { ...ctx, depth: ctx.depth + 1 };

  if ((segments[0].name === 'z' || segments[0].name === 'zod') && segments[0].args === null) {
    index = 1;
    while (segments[index] && ['coerce', 'iso', 'string_format'].includes(segments[index].name) && segments[index].args === null) {
      index++;
    }
    if (!segments[index]) return null;
    current = await interpretBase(segments[index], next);
    index++;
  } else if (segments[0].args === null) {
    const schema = await resolveSchemaByName(segments[0].name, ctx.filePath, ctx.loader, ctx.depth + 1);
    if (!schema) return null;
    current = { schema, optional: false };
    index = 1;
    // `schema.shape.field`
    if (segments[index]?.name === 'shape' && segments[index + 1]) {
      const field = segments[index + 1].name;
      const fieldSchema = schema.properties?.[field];
      if (!fieldSchema) return null;
      current = { schema: fieldSchema, optional: !schema.required?.includes(field) };
      index += 2;
    }
  }

  if (!current) return null;

  for (; index < segments.length; index++) {
    current = await applyModifier(current, segments[index], next);
  }
  return current;
}

/** Lee una expresión desde `start` hasta el fin de la sentencia (permite cadenas en varias líneas). */
function readExpression(code: string, start: number): string {
  for (let i = start; i < code.length; i++) {
    const char = code[i];
    if (char === '"' || char === "'" || char === '`') {
      const closing = findStringEnd(code, i);
      i = closing;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') {
      const end = findMatching(code, i);
      if (end === -1) return code.slice(start);
      i = end;
      continue;
    }
    if (char === ')' || char === '}' || char === ']' || char === ';' || char === ',') return code.slice(start, i);
    if (char === '\n') {
      const nextChar = code[skipWhitespace(code, i)];
      if (nextChar !== '.' && nextChar !== '?') return code.slice(start, i);
    }
  }
  return code.slice(start);
}

function findStringEnd(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === '\\') { i++; continue; }
    if (code[i] === quote) return i;
  }
  return code.length - 1;
}

const schemaCache = new WeakMap<SourceLoader, Map<string, Promise<JsonSchema | null>>>();

/**
 * Busca la declaración del schema `name` en `filePath` (o siguiendo sus imports /
 * re-exports) y la traduce a JSON Schema.
 */
export function resolveSchemaByName(name: string, filePath: string, loader: SourceLoader, depth = 0): Promise<JsonSchema | null> {
  let cache = schemaCache.get(loader);
  if (!cache) {
    cache = new Map();
    schemaCache.set(loader, cache);
  }
  const key = `${filePath}#${name}`;
  let cached = cache.get(key);
  if (!cached) {
    cached = resolveUncached(name, filePath, loader, depth);
    cache.set(key, cached);
  }
  return cached;
}

async function resolveUncached(name: string, filePath: string, loader: SourceLoader, depth: number): Promise<JsonSchema | null> {
  if (depth > MAX_DEPTH || IGNORED_RECEIVERS.has(name)) return null;
  const code = await loader.load(filePath);
  if (code === null) return null;
  const ctx: Context = { filePath, loader, depth };

  const escaped = name.replace(/\$/g, '\\$');
  const declaration = name === 'default'
    ? /export\s+default\s+/.exec(code)
    : new RegExp(`(?:^|[^\\w$.])(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=(?!=)\\s*`, 'm').exec(code);

  if (declaration) {
    const expression = readExpression(code, declaration.index + declaration[0].length);
    return (await interpretExpression(expression, ctx))?.schema ?? null;
  }

  const imports = parseImports(code);
  const binding = imports.get(name);
  if (binding) {
    const target = loader.resolve(filePath, binding.specifier);
    return target ? resolveSchemaByName(binding.imported, target, loader, depth + 1) : null;
  }

  // Re-exports: `export { a as b } from './x'` y `export * from './x'`.
  for (const match of code.matchAll(/export\s+(\{[^}]*\}|\*)\s+from\s+(['"])([^'"]+)\2/g)) {
    const target = loader.resolve(filePath, match[3]);
    if (!target) continue;
    if (match[1] === '*') {
      const found = await resolveSchemaByName(name, target, loader, depth + 1);
      if (found) return found;
      continue;
    }
    for (const part of match[1].slice(1, -1).split(',')) {
      const [imported, local] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      if ((local ?? imported) === name) return resolveSchemaByName(imported, target, loader, depth + 1);
    }
  }

  return null;
}

const EXAMPLE_BY_FORMAT: Record<string, unknown> = {
  email: 'user@example.com',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  uri: 'https://example.com',
  'date-time': '2024-01-01T00:00:00.000Z',
  date: '2024-01-01',
  time: '12:00:00',
  ipv4: '127.0.0.1',
  ipv6: '::1',
};

/** Genera un valor de ejemplo realista a partir de un JSON Schema inferido. */
export function exampleFromSchema(schema: JsonSchema, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.anyOf && schema.anyOf.length > 0) return exampleFromSchema(schema.anyOf[0], depth + 1);

  switch (schema.type) {
    case 'string':
      return (schema.format && EXAMPLE_BY_FORMAT[schema.format]) ?? 'string';
    case 'number':
    case 'integer':
      return 10;
    case 'boolean':
      return true;
    case 'array':
      return [exampleFromSchema(schema.items ?? {}, depth + 1)];
    case 'object': {
      if (schema.properties) {
        return Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [key, exampleFromSchema(value, depth + 1)]),
        );
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return { key: exampleFromSchema(schema.additionalProperties, depth + 1) };
      }
      return {};
    }
    default:
      return null;
  }
}

export interface InferredBody {
  schema: JsonSchema;
  example: unknown;
}

/**
 * Busca validaciones Zod en el cuerpo de un handler (`schema.parse(x)`, `safeParse`,
 * `parseAsync`, o `z.object({...}).parse(x)`) y devuelve el schema del primer body válido.
 */
export async function inferZodBody(handlerBody: string, filePath: string, loader: SourceLoader): Promise<InferredBody | null> {
  const ctx: Context = { filePath, loader, depth: 0 };

  for (const match of handlerBody.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:safeParse|parse|parseAsync|safeParseAsync)\s*\(/g)) {
    if (IGNORED_RECEIVERS.has(match[1])) continue;
    const schema = await resolveSchemaByName(match[1], filePath, loader);
    if (schema && (schema.type === 'object' || schema.properties)) {
      return { schema, example: exampleFromSchema(schema) };
    }
  }

  // Schema en línea: z.object({...}).parse(body)
  for (const match of handlerBody.matchAll(/\b(?:z|zod)\s*\.\s*object\s*\(/g)) {
    const open = match.index! + match[0].length - 1;
    const close = findMatching(handlerBody, open);
    if (close === -1) continue;
    const after = handlerBody.slice(close + 1);
    if (!/^\s*\.\s*(?:safeParse|parse|parseAsync|safeParseAsync)\s*\(/.test(after)) continue;
    const result = await interpretExpression(handlerBody.slice(match.index, close + 1), ctx);
    if (result) return { schema: result.schema, example: exampleFromSchema(result.schema) };
  }

  return null;
}

/** Interpreta el schema asociado a un identificador (útil para adapters que conocen el nombre del validador). */
export async function inferZodSchemaByName(name: string, filePath: string, loader: SourceLoader): Promise<InferredBody | null> {
  const schema = await resolveSchemaByName(name, filePath, loader);
  return schema ? { schema, example: exampleFromSchema(schema) } : null;
}

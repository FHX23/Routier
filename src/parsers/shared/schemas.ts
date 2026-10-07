import type { JsonSchema } from '../../types.js';
import { findMatching, objectLiteralProps, parseImports, parseLiteralValue, resolveExportedLocal, splitTopLevel } from './code.js';
import type { SourceLoader } from './source.js';
import { interpretExpression, parseChain, readExpression, type Segment } from './zod.js';

/**
 * Resolución de expresiones de validación a través de archivos y su interpretación con
 * la librería que corresponda: Zod, Joi, TypeBox o un JSON Schema literal.
 */

const MAX_DEPTH = 5;

export interface ResolvedExpression {
  text: string;
  filePath: string;
}

function declarationOf(code: string, name: string): string | null {
  const escaped = name.replace(/\$/g, '\\$');
  const match = new RegExp(`(?:^|[^\\w$.])(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?::[^=]+)?=(?!=)\\s*`, 'm').exec(code);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (code[start] === '{' || code[start] === '[') {
    const end = findMatching(code, start);
    if (end !== -1) {
      // Permite `{ ... } as const` y cadenas posteriores (`.keys(...)`).
      const rest = readExpression(code, end + 1);
      return code.slice(start, end + 1) + (rest.trim().startsWith('.') ? rest : '');
    }
  }
  return readExpression(code, start).trim().replace(/\s+as\s+const$/, '');
}

/** Valor asignado a `key` en `module.exports = { key: value }` / `exports.key = value`. */
function commonJsExport(code: string, key: string): string | null {
  const direct = new RegExp(`(?:module\\.)?exports\\.${key.replace(/\$/g, '\\$')}\\s*=\\s*`).exec(code);
  if (direct) return readExpression(code, direct.index + direct[0].length).trim();
  const object = /module\.exports\s*=\s*\{/.exec(code);
  if (object) {
    const open = object.index + object[0].length - 1;
    const props = objectLiteralProps(code.slice(open, findMatching(code, open) + 1));
    return props.get(key) ?? null;
  }
  return null;
}

/**
 * Sigue una expresión (`registerSchema`, `authValidation.register`, `Type.Object(...)`) hasta
 * su definición, atravesando imports, `require` y `module.exports`.
 */
export async function resolveExpression(text: string, filePath: string, loader: SourceLoader, depth = 0): Promise<ResolvedExpression | null> {
  const expression = text.trim();
  if (depth > MAX_DEPTH || !expression) return null;
  const code = await loader.load(filePath);
  if (code === null) return null;

  const identifier = /^([\w$]+)$/.exec(expression);
  const member = /^([\w$]+)\s*\.\s*([\w$]+)$/.exec(expression);
  if (!identifier && !member) return { text: expression, filePath };

  const base = identifier ? identifier[1] : member![1];
  const imports = parseImports(code);
  const binding = imports.get(base);

  if (!binding) {
    const local = declarationOf(code, base);
    if (!local) return null;
    if (!member) return resolveExpression(local, filePath, loader, depth + 1);
    // objeto.local: { register: {...} }
    const value = objectLiteralProps(local).get(member[2]);
    return value ? resolveExpression(value, filePath, loader, depth + 1) : null;
  }

  const target = loader.resolve(filePath, binding.specifier);
  const targetCode = target ? await loader.load(target) : null;
  if (!target || !targetCode) return null;

  // El nombre buscado en el módulo de destino.
  let key: string | null;
  if (member && (binding.imported === 'default' || binding.imported === '*')) {
    key = member[2];
  } else if (binding.imported === 'default') {
    key = resolveExportedLocal(targetCode, 'default');
  } else {
    key = binding.imported;
  }
  if (!key) return null;

  const exported = resolveExportedLocal(targetCode, key) ?? key;
  const declared = declarationOf(targetCode, exported) ?? commonJsExport(targetCode, key);
  if (!declared) return null;
  const resolved = await resolveExpression(declared, target, loader, depth + 1);
  if (!resolved || !member || binding.imported === 'default' || binding.imported === '*') return resolved;
  // import { validations } from ...; validations.register
  const value = objectLiteralProps(resolved.text).get(member[2]);
  return value ? resolveExpression(value, resolved.filePath, loader, depth + 1) : null;
}

// ---------------------------------------------------------------------------
// Joi
// ---------------------------------------------------------------------------

interface Interpreted {
  schema: JsonSchema;
  required: boolean;
}

async function joiObject(props: string, filePath: string, loader: SourceLoader, depth: number): Promise<JsonSchema> {
  const schema: JsonSchema = { type: 'object', properties: {}, 'x-validated': true };
  const required: string[] = [];
  for (const [key, value] of objectLiteralProps(props)) {
    const inner = await interpretJoi(value, filePath, loader, depth + 1);
    schema.properties![key] = inner?.schema ?? {};
    if (inner?.required) required.push(key);
  }
  if (required.length > 0) schema.required = required;
  return schema;
}

export async function interpretJoi(text: string, filePath: string, loader: SourceLoader, depth = 0): Promise<Interpreted | null> {
  if (depth > MAX_DEPTH) return null;
  const resolved = await resolveExpression(text, filePath, loader);
  if (!resolved) return null;
  const segments = parseChain(resolved.text);
  if (!segments || !/^joi$/i.test(segments[0].name)) return null;
  const file = resolved.filePath;

  let schema: JsonSchema = {};
  let required = false;
  for (const segment of segments.slice(1)) {
    const args = segment.args ?? '';
    const first = splitTopLevel(args)[0]?.trim() ?? '';
    const number = Number(first);
    switch (segment.name) {
      case 'string': schema = { ...schema, type: 'string' }; break;
      case 'number': schema = { ...schema, type: 'number' }; break;
      case 'integer': schema = { ...schema, type: 'integer' }; break;
      case 'boolean': case 'bool': schema = { ...schema, type: 'boolean' }; break;
      case 'date': schema = { ...schema, type: 'string', format: 'date-time' }; break;
      case 'email': schema = { ...schema, type: 'string', format: 'email' }; break;
      case 'uri': schema = { ...schema, type: 'string', format: 'uri' }; break;
      case 'guid': case 'uuid': schema = { ...schema, type: 'string', format: 'uuid' }; break;
      case 'isoDate': schema = { ...schema, type: 'string', format: 'date-time' }; break;
      case 'required': required = true; break;
      case 'optional': required = false; break;
      case 'valid': case 'allow': {
        const values = splitTopLevel(args).map(parseLiteralValue).filter((value) => value !== undefined && value !== null && value !== '');
        if (segment.name === 'valid' && values.length > 0) schema = { ...schema, enum: values };
        break;
      }
      case 'default': {
        const value = parseLiteralValue(args);
        if (value !== undefined) schema = { ...schema, default: value };
        break;
      }
      case 'min': case 'max': case 'length':
        if (Number.isFinite(number) && first !== '') {
          const isString = schema.type === 'string';
          const isArray = schema.type === 'array';
          if (segment.name !== 'max') schema = { ...schema, ...(isString ? { minLength: number } : isArray ? { minItems: number } : { minimum: number }) };
          // El máximo de un array no limita los ejemplos (se genera un solo elemento).
          if (segment.name !== 'min' && !isArray) schema = { ...schema, ...(isString ? { maxLength: number } : { maximum: number }) };
        }
        break;
      case 'pattern': case 'regex': {
        const literal = /^\/((?:\\.|[^/\\])+)\/[a-z]*$/.exec(first);
        if (literal) schema = { ...schema, pattern: literal[1] };
        break;
      }
      case 'array': schema = { ...schema, type: 'array', items: {} }; break;
      case 'items': {
        const inner = await interpretJoi(first, file, loader, depth + 1);
        schema = { ...schema, type: 'array', items: inner?.schema ?? {} };
        break;
      }
      case 'object':
        schema = first.startsWith('{') ? await joiObject(first, file, loader, depth) : { type: 'object' };
        break;
      case 'keys':
        if (first.startsWith('{')) {
          const extra = await joiObject(first, file, loader, depth);
          schema = { ...extra, properties: { ...schema.properties, ...extra.properties }, required: [...(schema.required ?? []), ...(extra.required ?? [])] };
          if (schema.required?.length === 0) delete schema.required;
        }
        break;
      default:
        break; // custom, messages, label, trim, lowercase...
    }
  }
  return { schema, required };
}

// ---------------------------------------------------------------------------
// TypeBox
// ---------------------------------------------------------------------------

function typeboxOptions(text: string | undefined): JsonSchema {
  if (!text) return {};
  const options = parseLiteralValue(text);
  if (!options || typeof options !== 'object') return {};
  const allowed = ['format', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'default', 'minItems'];
  return Object.fromEntries(Object.entries(options).filter(([key]) => allowed.includes(key))) as JsonSchema;
}

export async function interpretTypeBox(text: string, filePath: string, loader: SourceLoader, depth = 0): Promise<Interpreted | null> {
  if (depth > MAX_DEPTH) return null;
  const resolved = await resolveExpression(text, filePath, loader);
  if (!resolved) return null;
  const segments = parseChain(resolved.text);
  if (!segments || !['Type', 't', 'T'].includes(segments[0].name) || !segments[1]) return null;
  const file = resolved.filePath;
  const call: Segment = segments[1];
  const args = splitTopLevel(call.args ?? '');

  switch (call.name) {
    case 'String': return { schema: { type: 'string', ...typeboxOptions(args[0]) }, required: true };
    case 'Number': return { schema: { type: 'number', ...typeboxOptions(args[0]) }, required: true };
    case 'Integer': return { schema: { type: 'integer', ...typeboxOptions(args[0]) }, required: true };
    case 'Boolean': return { schema: { type: 'boolean' }, required: true };
    case 'Date': return { schema: { type: 'string', format: 'date-time' }, required: true };
    case 'Literal': {
      const value = parseLiteralValue(args[0] ?? '');
      return { schema: { type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string', enum: [value] }, required: true };
    }
    case 'Optional': {
      const inner = await interpretTypeBox(args[0] ?? '', file, loader, depth + 1);
      return inner ? { schema: inner.schema, required: false } : null;
    }
    case 'Array': {
      const inner = await interpretTypeBox(args[0] ?? '', file, loader, depth + 1);
      return { schema: { type: 'array', items: inner?.schema ?? {}, ...typeboxOptions(args[1]) }, required: true };
    }
    case 'Union': {
      const list = args[0]?.trim() ?? '';
      const options = list.startsWith('[') ? splitTopLevel(list.slice(1, -1)) : [];
      const schemas = (await Promise.all(options.map((option) => interpretTypeBox(option, file, loader, depth + 1))))
        .filter((option): option is Interpreted => option !== null).map((option) => option.schema);
      const literals = schemas.every((s) => s.enum?.length === 1) ? schemas.map((s) => s.enum![0]) : null;
      return { schema: literals ? { type: 'string', enum: literals } : { anyOf: schemas }, required: true };
    }
    case 'Object': {
      const schema: JsonSchema = { type: 'object', properties: {}, 'x-validated': true };
      const required: string[] = [];
      for (const [key, value] of objectLiteralProps(args[0] ?? '{}')) {
        const inner = await interpretTypeBox(value, file, loader, depth + 1);
        schema.properties![key] = inner?.schema ?? {};
        if (inner?.required !== false) required.push(key);
      }
      if (required.length > 0) schema.required = required;
      return { schema, required: true };
    }
    case 'Record': return { schema: { type: 'object' }, required: true };
    default: return { schema: {}, required: true };
  }
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

/**
 * Interpreta una expresión de validación con la librería que corresponda
 * (Joi, TypeBox, Zod o un JSON Schema literal).
 */
export async function interpretSchema(text: string, filePath: string, loader: SourceLoader): Promise<JsonSchema | null> {
  const resolved = await resolveExpression(text, filePath, loader);
  if (!resolved) return null;
  const expression = resolved.text.trim();
  if (/^joi\s*\./i.test(expression)) return (await interpretJoi(expression, resolved.filePath, loader))?.schema ?? null;
  if (/^(?:Type|t)\s*\.\s*[A-Z]/.test(expression)) return (await interpretTypeBox(expression, resolved.filePath, loader))?.schema ?? null;
  if (expression.startsWith('{')) {
    const literal = parseLiteralValue(expression);
    return literal && typeof literal === 'object' ? (literal as JsonSchema) : null;
  }
  const zod = await interpretExpression(expression, { filePath: resolved.filePath, loader, depth: 0 });
  return zod?.schema ?? null;
}

export interface ValidatorObject {
  body?: JsonSchema;
  /** Schema de la query (propiedades y obligatorios). */
  query?: JsonSchema;
  headers?: string[];
}

/**
 * Objeto validador `{ body, query, params }` (celebrate, validate(schema) de boilerplates,
 * schema de ruta de Fastify): devuelve el schema del body y las claves de la query.
 */
export async function interpretValidatorObject(text: string, filePath: string, loader: SourceLoader): Promise<ValidatorObject | null> {
  const resolved = await resolveExpression(text, filePath, loader);
  if (!resolved || !resolved.text.trim().startsWith('{')) return null;
  const props = objectLiteralProps(resolved.text.trim());
  const pick = (...keys: string[]) => keys.map((key) => props.get(key) ?? props.get(`[Segments.${key.toUpperCase()}]`)).find(Boolean);
  const bodyText = pick('body');
  const queryText = pick('query', 'querystring');
  const headersText = pick('headers');
  if (!bodyText && !queryText && !headersText) return null;

  const result: ValidatorObject = {};
  if (bodyText) result.body = (await interpretSchema(bodyText, resolved.filePath, loader)) ?? undefined;
  if (queryText) {
    const schema = await interpretSchema(queryText, resolved.filePath, loader);
    if (schema?.properties) result.query = schema;
  }
  if (headersText) result.headers = Object.keys((await interpretSchema(headersText, resolved.filePath, loader))?.properties ?? {});
  return result;
}


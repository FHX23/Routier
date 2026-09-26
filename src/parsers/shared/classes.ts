import type { JsonSchema } from '../../types.js';
import { findMatching, parseImports, parseLiteralValue, parseStringLiteral, resolveExportedLocal, skipWhitespace, splitTopLevel } from './code.js';
import type { SourceLoader } from './source.js';
import { resolveSchemaByName } from './zod.js';

/**
 * Lectura estática de clases TypeScript con decoradores (controladores de NestJS y DTOs
 * de class-validator). No usa el compilador de TypeScript: recorre los miembros del cuerpo
 * de la clase respetando llaves, paréntesis y strings.
 */

export interface Decorator {
  name: string;
  args: string;
}

export interface ClassMember {
  kind: 'property' | 'method';
  name: string;
  decorators: Decorator[];
  optional: boolean;
  /** Tipo declarado (propiedades). */
  type?: string;
  /** Lista de parámetros sin paréntesis (métodos). */
  params?: string;
  /** Cuerpo con llaves (métodos). */
  body?: string;
}

export interface ClassDeclaration {
  name: string;
  /** Texto entre el nombre y la llave de apertura (`extends X implements Y`). */
  heritage: string;
  /** Decoradores de la clase. */
  decorators: Decorator[];
  body: string;
  start: number;
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'static', 'async', 'override', 'declare', 'abstract', 'accessor']);

/** Lee decoradores consecutivos desde `index`. */
export function readDecorators(code: string, index: number): { decorators: Decorator[]; end: number } {
  const decorators: Decorator[] = [];
  let i = skipWhitespace(code, index);
  while (code[i] === '@') {
    const name = /^@([\w$.]+)/.exec(code.slice(i));
    if (!name) break;
    i += name[0].length;
    let args = '';
    const next = skipWhitespace(code, i);
    if (code[next] === '(') {
      const close = findMatching(code, next);
      if (close === -1) break;
      args = code.slice(next + 1, close);
      i = close + 1;
    }
    decorators.push({ name: name[1].split('.').pop()!, args });
    i = skipWhitespace(code, i);
  }
  return { decorators, end: i };
}

/** Avanza hasta el final de una declaración (`;` o salto de línea en el nivel superior). */
function skipStatement(code: string, index: number): number {
  let angle = 0;
  for (let i = index; i < code.length; i++) {
    const char = code[i];
    if (char === '(' || char === '{' || char === '[') {
      const close = findMatching(code, i);
      if (close === -1) return code.length;
      i = close;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      for (i++; i < code.length && code[i] !== quote; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (char === '<') angle++;
    else if (char === '>' && code[i - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (char === ';' || char === '}') return i;
    else if (char === '\n' && angle === 0) {
      // Continúa si la siguiente línea sigue la expresión (`|`, `&`, `.`, `?`, `:`).
      const next = code[skipWhitespace(code, i)];
      if (next && '|&.?:=>'.includes(next)) continue;
      return i;
    }
  }
  return code.length;
}

/** Recorre los miembros de un cuerpo de clase (incluyendo llaves). */
export function scanClassMembers(classBody: string): ClassMember[] {
  const code = classBody.trim().replace(/^\{/, '').replace(/\}$/, '');
  const members: ClassMember[] = [];
  let i = 0;

  while (i < code.length) {
    const { decorators, end } = readDecorators(code, i);
    i = end;
    if (i >= code.length) break;
    if (code[i] === ';' || code[i] === ',') { i++; continue; }
    if (code[i] === '[' || code[i] === '#') { i = skipStatement(code, i) + 1; continue; }

    // Modificadores y accessors
    let name: string | null = null;
    while (i < code.length) {
      const word = /^[\w$]+/.exec(code.slice(i));
      if (!word) break;
      const after = skipWhitespace(code, i + word[0].length);
      const isModifier = (MODIFIERS.has(word[0]) || word[0] === 'get' || word[0] === 'set') && /[\w$#[]/.test(code[after] ?? '');
      if (isModifier) { i = after; continue; }
      name = word[0];
      i = after;
      break;
    }
    if (!name) { i++; continue; }

    let optional = false;
    if (code[i] === '?' || code[i] === '!') { optional = code[i] === '?'; i = skipWhitespace(code, i + 1); }
    if (code[i] === '<') {
      const close = code.indexOf('>', i);
      i = close === -1 ? i + 1 : skipWhitespace(code, close + 1);
    }

    if (code[i] === '(') {
      const close = findMatching(code, i);
      if (close === -1) break;
      const params = code.slice(i + 1, close);
      let j = skipWhitespace(code, close + 1);
      if (code[j] === ':') {
        // Tipo de retorno: avanzar hasta la llave del cuerpo en el nivel superior.
        let angle = 0;
        for (j++; j < code.length; j++) {
          const char = code[j];
          if (char === '<') angle++;
          else if (char === '>') angle--;
          else if ((char === '(' || char === '[') || (char === '{' && angle > 0)) j = findMatching(code, j);
          else if ((char === '{' && angle === 0) || char === ';') break;
        }
      }
      let body: string | undefined;
      if (code[j] === '{') {
        const bodyEnd = findMatching(code, j);
        body = code.slice(j, bodyEnd + 1);
        j = bodyEnd + 1;
      } else {
        j = skipStatement(code, j) + 1;
      }
      members.push({ kind: 'method', name, decorators, optional, params, body });
      i = j;
      continue;
    }

    let type: string | undefined;
    if (code[i] === ':') {
      const start = i + 1;
      let j = start;
      let angle = 0;
      for (; j < code.length; j++) {
        const char = code[j];
        if (char === '(' || char === '{' || char === '[') { j = findMatching(code, j); if (j === -1) { j = code.length; break; } continue; }
        if (char === '<') angle++;
        else if (char === '>' && code[j - 1] !== '=') angle--;
        else if (angle === 0 && (char === ';' || char === '=' || char === '}')) break;
        else if (angle === 0 && char === '\n') {
          const next = code[skipWhitespace(code, j)];
          if (!next || !'|&'.includes(next)) break;
        }
      }
      type = code.slice(start, j).trim();
      i = j;
    }
    if (code[i] === '=') i = skipStatement(code, i + 1);
    members.push({ kind: 'property', name, decorators, optional, type });
    if (code[i] === ';' || code[i] === '\n') i++;
  }

  return members;
}

/** Busca una clase por nombre en `code` junto con sus decoradores. */
export function findClass(code: string, name?: string): ClassDeclaration | null {
  const pattern = name
    ? new RegExp(`(?:^|[^\\w$.])class\\s+(${name.replace(/\$/g, '\\$')})\\b([^{]*)\\{`, 'm')
    : /(?:^|[^\w$.])class\s+([\w$]+)\b([^{]*)\{/m;
  const match = pattern.exec(code);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const close = findMatching(code, open);
  if (close === -1) return null;
  return {
    name: match[1],
    heritage: match[2].trim(),
    decorators: decoratorsBefore(code, match.index),
    body: code.slice(open, close + 1),
    start: match.index,
  };
}

/** Todas las clases del archivo que tienen el decorador `decoratorName`. */
export function findDecoratedClasses(code: string, decoratorName: string): ClassDeclaration[] {
  const classes: ClassDeclaration[] = [];
  const pattern = /(?:^|[^\w$.])class\s+([\w$]+)\b([^{]*)\{/gm;
  for (const match of code.matchAll(pattern)) {
    const decorators = decoratorsBefore(code, match.index!);
    if (!decorators.some((decorator) => decorator.name === decoratorName)) continue;
    const open = match.index! + match[0].length - 1;
    const close = findMatching(code, open);
    if (close === -1) continue;
    classes.push({ name: match[1], heritage: match[2].trim(), decorators, body: code.slice(open, close + 1), start: match.index! });
  }
  return classes;
}

/** Decoradores escritos justo antes de `index` (saltando `export`, `default`, `abstract`). */
function decoratorsBefore(code: string, index: number): Decorator[] {
  // Retrocede hasta el final de la sentencia anterior en el nivel superior.
  let start = index;
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const char = code[i];
    // Las llaves de los argumentos de un decorador siempre están dentro de paréntesis.
    if (depth === 0 && (char === ';' || char === '}' || char === '{')) break;
    if (char === ')' || char === ']' || char === '}') depth++;
    else if (char === '(' || char === '[' || char === '{') depth--;
    if (depth < 0) break;
    start = i;
  }
  const region = code.slice(start, index);
  const at = region.indexOf('@');
  if (at === -1) return [];
  return readDecorators(region, at).decorators;
}

export function firstStringArg(args: string): string | null {
  const first = splitTopLevel(args)[0];
  return first === undefined ? null : parseStringLiteral(first);
}

// ---------------------------------------------------------------------------
// DTOs -> JSON Schema
// ---------------------------------------------------------------------------

const MAX_DEPTH = 5;

const VALIDATOR_FORMATS: Record<string, JsonSchema> = {
  IsString: { type: 'string' },
  IsEmail: { type: 'string', format: 'email' },
  IsUUID: { type: 'string', format: 'uuid' },
  IsUrl: { type: 'string', format: 'uri' },
  IsDateString: { type: 'string', format: 'date-time' },
  IsISO8601: { type: 'string', format: 'date-time' },
  IsDate: { type: 'string', format: 'date-time' },
  IsInt: { type: 'integer' },
  IsNumber: { type: 'number' },
  IsNumberString: { type: 'string' },
  IsBoolean: { type: 'boolean' },
  IsPhoneNumber: { type: 'string' },
  IsJWT: { type: 'string', format: 'jwt' },
};

interface TypeContext {
  filePath: string;
  loader: SourceLoader;
  depth: number;
}

async function locate(name: string, ctx: TypeContext): Promise<{ code: string; filePath: string; name: string } | null> {
  const code = await ctx.loader.load(ctx.filePath);
  if (code === null) return null;
  const escaped = name.replace(/\$/g, '\\$');
  if (new RegExp(`(?:class|enum|type|interface)\\s+${escaped}\\b`).test(code)) return { code, filePath: ctx.filePath, name };

  const binding = parseImports(code).get(name);
  if (!binding) return null;
  const target = ctx.loader.resolve(ctx.filePath, binding.specifier);
  const targetCode = target ? await ctx.loader.load(target) : null;
  if (!target || !targetCode) return null;
  const local = binding.imported === 'default' ? resolveExportedLocal(targetCode, 'default') ?? name : binding.imported;
  return { code: targetCode, filePath: target, name: local };
}

function withoutRequired(schema: JsonSchema): JsonSchema {
  return { ...schema, required: undefined };
}

function listLiteral(text: string | undefined): string[] {
  const value = text ? parseLiteralValue(text.replace(/\s+as\s+const\s*$/, '')) : undefined;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mergeObjects(a: JsonSchema, b: JsonSchema): JsonSchema {
  const required = [...(a.required ?? []), ...(b.required ?? [])];
  return {
    type: 'object',
    properties: { ...a.properties, ...b.properties },
    required: required.length > 0 ? [...new Set(required)] : undefined,
  };
}

/** Schema de la clase base declarada en `extends ...` (incluye los mapped types de @nestjs/swagger y createZodDto). */
async function heritageSchema(heritage: string, ctx: TypeContext): Promise<JsonSchema | null> {
  const extendsMatch = /extends\s+([\s\S]+?)(?:\s+implements\b|$)/.exec(heritage);
  if (!extendsMatch) return null;
  const expression = extendsMatch[1].trim();
  const call = /^([\w$]+)\s*\(([\s\S]*)\)$/.exec(expression);
  if (!call) return resolveTypeSchema(expression.replace(/<[\s\S]*>$/, ''), { ...ctx, depth: ctx.depth + 1 });

  const [, helper, rawArgs] = call;
  const args = splitTopLevel(rawArgs);
  const next = { ...ctx, depth: ctx.depth + 1 };

  if (helper === 'createZodDto') {
    return resolveSchemaByName(args[0]?.trim() ?? '', ctx.filePath, ctx.loader, ctx.depth + 1);
  }
  const base = args[0] ? await resolveTypeSchema(args[0].trim(), next) : null;
  if (!base) return null;

  switch (helper) {
    case 'PartialType':
      return withoutRequired(base);
    case 'PickType':
    case 'OmitType': {
      const keys = new Set(listLiteral(args[1]));
      const keep = (key: string) => (helper === 'PickType' ? keys.has(key) : !keys.has(key));
      const properties = Object.fromEntries(Object.entries(base.properties ?? {}).filter(([key]) => keep(key)));
      const required = base.required?.filter(keep);
      return { type: 'object', properties, required: required?.length ? required : undefined };
    }
    case 'IntersectionType': {
      let merged = base;
      for (const arg of args.slice(1)) {
        const other = await resolveTypeSchema(arg.trim(), next);
        if (other) merged = mergeObjects(merged, other);
      }
      return merged;
    }
    default:
      return base;
  }
}

async function propertySchema(member: ClassMember, ctx: TypeContext): Promise<{ schema: JsonSchema; optional: boolean }> {
  const names = new Set(member.decorators.map((decorator) => decorator.name));
  let optional = member.optional || names.has('IsOptional') || names.has('ApiPropertyOptional');
  let schema: JsonSchema = {};

  const typeDecorator = member.decorators.find((decorator) => decorator.name === 'Type');
  const nestedClass = typeDecorator ? /=>\s*([\w$]+)/.exec(typeDecorator.args)?.[1] : undefined;

  if (member.type) {
    const typed = await typeTextToSchema(member.type, ctx);
    schema = typed.schema;
    optional ||= typed.optional;
  }
  if (nestedClass && !['String', 'Number', 'Boolean', 'Date'].includes(nestedClass)) {
    const nested = await resolveTypeSchema(nestedClass, { ...ctx, depth: ctx.depth + 1 });
    if (nested) schema = schema.type === 'array' ? { type: 'array', items: nested } : nested;
  }

  for (const decorator of member.decorators) {
    const format = VALIDATOR_FORMATS[decorator.name];
    if (format) {
      schema = schema.type === 'array' && names.has('IsArray') ? { ...schema, items: { ...schema.items, ...format } } : { ...schema, ...format };
    }
    if (decorator.name === 'IsIn') {
      const values = parseLiteralValue(splitTopLevel(decorator.args)[0] ?? '');
      if (Array.isArray(values)) schema = { ...schema, enum: values };
    }
    if (decorator.name === 'IsEnum') {
      const enumSchema = await resolveTypeSchema(splitTopLevel(decorator.args)[0]?.trim() ?? '', { ...ctx, depth: ctx.depth + 1 });
      if (enumSchema?.enum) schema = { ...schema, type: 'string', enum: enumSchema.enum };
    }
    if (decorator.name === 'IsArray' && schema.type !== 'array') schema = { type: 'array', items: schema.type ? schema : {} };
  }

  return { schema, optional };
}

/** Convierte un tipo TypeScript escrito en texto a JSON Schema. */
export async function typeTextToSchema(typeText: string, ctx: TypeContext): Promise<{ schema: JsonSchema; optional: boolean }> {
  let text = typeText.trim();
  let optional = false;
  let nullable = false;

  const parts = splitTopLevel(text, '|').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const rest = parts.filter((part) => {
      if (part === 'undefined') { optional = true; return false; }
      if (part === 'null') { nullable = true; return false; }
      return true;
    });
    const literals = rest.map(parseStringLiteral);
    if (literals.every((literal): literal is string => literal !== null)) {
      return { schema: { type: 'string', enum: literals, ...(nullable ? { nullable } : {}) }, optional };
    }
    text = rest[0] ?? 'unknown';
  }

  const finish = (schema: JsonSchema) => ({ schema: nullable ? { ...schema, nullable } : schema, optional });

  const arrayMatch = /^(.+)\[\]$/.exec(text) ?? /^(?:Array|ReadonlyArray|Set)<([\s\S]+)>$/.exec(text);
  if (arrayMatch) {
    const inner = await typeTextToSchema(arrayMatch[1].replace(/^\((.*)\)$/, '$1'), ctx);
    return finish({ type: 'array', items: inner.schema });
  }

  switch (text) {
    case 'string': return finish({ type: 'string' });
    case 'number': return finish({ type: 'number' });
    case 'bigint': return finish({ type: 'integer' });
    case 'boolean': return finish({ type: 'boolean' });
    case 'Date': return finish({ type: 'string', format: 'date-time' });
    case 'any':
    case 'unknown':
      return finish({});
  }
  if (/^(Record|Map)</.test(text) || text === 'object' || text.startsWith('{')) return finish({ type: 'object' });
  const literal = parseStringLiteral(text);
  if (literal !== null) return finish({ type: 'string', enum: [literal] });

  if (/^[\w$]+$/.test(text) && ctx.depth < MAX_DEPTH) {
    const resolved = await resolveTypeSchema(text, { ...ctx, depth: ctx.depth + 1 });
    if (resolved) return finish(resolved);
  }
  return finish({});
}

/** Resuelve un nombre de tipo (clase DTO, enum, alias de unión de literales o schema Zod) a JSON Schema. */
export async function resolveTypeSchema(name: string, ctx: TypeContext): Promise<JsonSchema | null> {
  if (!name || ctx.depth > MAX_DEPTH) return null;
  const found = await locate(name, ctx);
  if (!found) return resolveSchemaByName(name, ctx.filePath, ctx.loader, ctx.depth);
  const local = { ...ctx, filePath: found.filePath };
  const escaped = found.name.replace(/\$/g, '\\$');

  const enumMatch = new RegExp(`enum\\s+${escaped}\\s*\\{`).exec(found.code);
  if (enumMatch) {
    const open = enumMatch.index + enumMatch[0].length - 1;
    const body = found.code.slice(open + 1, findMatching(found.code, open));
    const values = splitTopLevel(body).map((entry) => {
      const [key, value] = entry.split('=').map((part) => part.trim());
      return value !== undefined ? parseLiteralValue(value) ?? key : key;
    });
    return { type: typeof values[0] === 'number' ? 'number' : 'string', enum: values };
  }

  const alias = new RegExp(`type\\s+${escaped}\\s*=\\s*([^;]+)`).exec(found.code);
  if (alias) return (await typeTextToSchema(alias[1], local)).schema;

  const declaration = findClass(found.code, found.name) ?? findInterface(found.code, found.name);
  if (!declaration) return null;

  let schema: JsonSchema = { type: 'object', properties: {} };
  const base = await heritageSchema(declaration.heritage, local);
  if (base) schema = mergeObjects(schema, base);

  const required: string[] = [];
  for (const member of scanClassMembers(declaration.body)) {
    if (member.kind !== 'property') continue;
    const property = await propertySchema(member, local);
    schema.properties![member.name] = property.schema;
    if (!property.optional) required.push(member.name);
  }
  return mergeObjects(schema, { required });
}

function findInterface(code: string, name: string): ClassDeclaration | null {
  const match = new RegExp(`interface\\s+${name.replace(/\$/g, '\\$')}\\b([^{]*)\\{`).exec(code);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const close = findMatching(code, open);
  if (close === -1) return null;
  return { name, heritage: match[1].trim(), decorators: [], body: code.slice(open, close + 1), start: match.index };
}

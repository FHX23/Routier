import type { JsonSchema } from '../../types.js';

/**
 * Genera valores de ejemplo que respetan las validaciones inferidas (formatos, largos,
 * mínimos/máximos y expresiones regulares simples), para que las requests exportadas
 * pasen la validación del servidor sin tener que editarlas a mano.
 */

const MAX_DEPTH = 6;

const EXAMPLE_BY_FORMAT: Record<string, string> = {
  email: 'user@example.com',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  uri: 'https://example.com',
  'date-time': '2024-01-01T00:00:00.000Z',
  date: '2024-01-01',
  time: '12:00:00',
  ipv4: '127.0.0.1',
  ipv6: '::1',
  cuid: 'cjld2cjxh0000qzrmn831i7rn',
  cuid2: 'tz4a98xxat96iws9zmbrgj3a',
  ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  nanoid: 'V1StGXR8_Z5jdHi6B-myT',
  e164: '+14155552671',
  byte: 'cm91dGllcg==',
  binary: '',
};

/** Pistas por nombre de campo cuando el schema no dice nada más que "string". */
const NAME_HINTS: [RegExp, string][] = [
  [/e-?mail|correo/i, 'user@example.com'],
  [/password|contrase(n|ñ)a|passwd/i, 'Passw0rd!123'],
  [/url|website|sitio|link|href/i, 'https://example.com'],
  [/(^|_)(date|fecha)|(Date|Fecha|At)$/, '2024-01-01T00:00:00.000Z'],
];

// ---------------------------------------------------------------------------
// Expresiones regulares -> string de ejemplo
// ---------------------------------------------------------------------------

type Node =
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; options: Node[] }
  | { kind: 'char'; value: string }
  | { kind: 'repeat'; node: Node; min: number; max: number };

const CLASS_SAMPLES: Record<string, string> = { d: '1', w: 'a', s: ' ', D: 'a', W: '-', S: 'a' };

function parseClass(source: string, start: number): { value: string; end: number } {
  let i = start + 1;
  const negated = source[i] === '^';
  if (negated) i++;
  const members: string[] = [];
  const ranges: [string, string][] = [];
  let first = true;
  for (; i < source.length && (source[i] !== ']' || first); i++) {
    first = false;
    let char = source[i];
    if (char === '\\') {
      i++;
      const escaped = source[i];
      if (CLASS_SAMPLES[escaped]) {
        members.push(CLASS_SAMPLES[escaped]);
        continue;
      }
      char = escaped;
    }
    if (source[i + 1] === '-' && source[i + 2] && source[i + 2] !== ']') {
      let to = source[i + 2];
      let skip = 2;
      if (to === '\\') { to = source[i + 3]; skip = 3; }
      ranges.push([char, to]);
      i += skip;
      continue;
    }
    members.push(char);
  }
  if (!negated) {
    return { value: ranges[0]?.[0] ?? members[0] ?? 'a', end: i };
  }
  const excluded = (c: string) => members.includes(c) || ranges.some(([a, b]) => c >= a && c <= b);
  const candidate = ['a', 'x', '1', 'Z', '_'].find((c) => !excluded(c)) ?? 'a';
  return { value: candidate, end: i };
}

function parseRegex(source: string): Node {
  let i = 0;

  function parseAlternation(): Node {
    const options: Node[] = [parseSequence()];
    while (source[i] === '|') {
      i++;
      options.push(parseSequence());
    }
    return options.length === 1 ? options[0] : { kind: 'alt', options };
  }

  function parseSequence(): Node {
    const items: Node[] = [];
    while (i < source.length && source[i] !== '|' && source[i] !== ')') {
      let atom = parseAtom();
      if (!atom) continue;
      atom = parseQuantifier(atom);
      items.push(atom);
    }
    return { kind: 'seq', items };
  }

  function parseAtom(): Node | null {
    const char = source[i];
    if (char === '^' || char === '$') { i++; return null; }
    if (char === '(') {
      i++;
      let lookaround = false;
      if (source[i] === '?') {
        if (source[i + 1] === ':') i += 2;
        else if (source[i + 1] === '=' || source[i + 1] === '!') { lookaround = true; i += 2; }
        else if (source[i + 1] === '<' && (source[i + 2] === '=' || source[i + 2] === '!')) { lookaround = true; i += 3; }
        else if (source[i + 1] === '<') { i = source.indexOf('>', i) + 1; }
      }
      const inner = parseAlternation();
      i++; // ')'
      return lookaround ? null : inner;
    }
    if (char === '[') {
      const { value, end } = parseClass(source, i);
      i = end + 1;
      return { kind: 'char', value };
    }
    if (char === '\\') {
      const escaped = source[i + 1];
      i += 2;
      if (escaped === 'b' || escaped === 'B') return null;
      if (CLASS_SAMPLES[escaped]) return { kind: 'char', value: CLASS_SAMPLES[escaped] };
      if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i, i + 4))) {
        const value = String.fromCharCode(parseInt(source.slice(i, i + 4), 16));
        i += 4;
        return { kind: 'char', value };
      }
      return { kind: 'char', value: escaped };
    }
    i++;
    if (char === '.') return { kind: 'char', value: 'a' };
    return { kind: 'char', value: char };
  }

  function parseQuantifier(node: Node): Node {
    const char = source[i];
    let min: number;
    let max: number;
    if (char === '*') { min = 0; max = Infinity; i++; }
    else if (char === '+') { min = 1; max = Infinity; i++; }
    else if (char === '?') { min = 0; max = 1; i++; }
    else if (char === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(i))) {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))!;
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
      i += match[0].length;
    } else {
      return node;
    }
    if (source[i] === '?' || source[i] === '+') i++; // perezoso / posesivo
    return { kind: 'repeat', node, min, max };
  }

  return parseAlternation();
}

/** Genera un string para el AST; `extra` repeticiones adicionales se asignan al primer cuantificador abierto. */
function generate(node: Node, budget: { extra: number }): string {
  switch (node.kind) {
    case 'char':
      return node.value;
    case 'seq':
      return node.items.map((item) => generate(item, budget)).join('');
    case 'alt':
      return generate(node.options[0], budget);
    case 'repeat': {
      let count = Math.max(node.min, node.max === 0 ? 0 : node.min);
      if (budget.extra > 0 && node.max > count) {
        const add = Math.min(budget.extra, node.max - count);
        count += add;
        budget.extra -= add;
      }
      return Array.from({ length: count }, () => generate(node.node, budget)).join('');
    }
  }
}

const STRONG_CANDIDATES = ['Passw0rd!123', 'Aa1!aaaa', 'Abcdef1!', 'aA1#aA1#aA1#'];

/** Devuelve un string que cumple `pattern` y los largos indicados, o `null` si no se logra. */
export function exampleFromPattern(pattern: string, minLength = 0, maxLength = Infinity): string | null {
  let regex: RegExp;
  let ast: Node;
  try {
    regex = new RegExp(pattern, 'u');
    ast = parseRegex(pattern);
  } catch {
    try {
      regex = new RegExp(pattern);
      ast = parseRegex(pattern);
    } catch {
      return null;
    }
  }
  const fits = (value: string) => regex.test(value) && value.length >= minLength && value.length <= maxLength;

  for (let extra = 0; extra <= Math.max(minLength, 8) + 4; extra++) {
    const value = generate(ast, { extra });
    if (fits(value)) return value;
    if (value.length > maxLength) break;
  }
  // Patrones con lookaheads (típicos de contraseñas): probar valores fuertes conocidos.
  for (const candidate of STRONG_CANDIDATES) {
    const padded = candidate.length < minLength ? candidate + 'a'.repeat(minLength - candidate.length) : candidate;
    if (fits(padded)) return padded;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON Schema -> ejemplo
// ---------------------------------------------------------------------------

function fitLength(value: string, schema: JsonSchema): string {
  let result = value;
  if (schema.minLength !== undefined && result.length < schema.minLength) {
    result = result + 'x'.repeat(schema.minLength - result.length);
  }
  if (schema.maxLength !== undefined && result.length > schema.maxLength) {
    result = result.slice(0, Math.max(schema.maxLength, 0));
  }
  return result;
}

function stringExample(schema: JsonSchema, name?: string): string {
  if (schema.pattern) {
    const fromPattern = exampleFromPattern(schema.pattern, schema.minLength, schema.maxLength);
    if (fromPattern !== null) return fromPattern;
  }
  if (schema.format && EXAMPLE_BY_FORMAT[schema.format] !== undefined) return EXAMPLE_BY_FORMAT[schema.format];
  if (name) {
    const hint = NAME_HINTS.find(([regex]) => regex.test(name));
    if (hint) {
      const value = hint[1];
      const fitsLength = (schema.minLength ?? 0) <= value.length && value.length <= (schema.maxLength ?? Infinity);
      if (fitsLength) return value;
    }
  }
  return fitLength('string', schema);
}

function numberExample(schema: JsonSchema): number {
  let value = 10;
  if (schema.minimum !== undefined && value < schema.minimum) value = schema.minimum;
  if (schema.maximum !== undefined && value > schema.maximum) value = schema.maximum;
  if (schema.type === 'integer') value = Math.ceil(value);
  return value;
}

/** Genera un valor de ejemplo realista a partir de un JSON Schema inferido. */
export function exampleFromSchema(schema: JsonSchema, name?: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.anyOf && schema.anyOf.length > 0) {
    // Preferir una opción con contenido (no el literal vacío de `.optional().or(z.literal(''))`).
    const option = schema.anyOf.find((candidate) => !(candidate.enum?.length === 1 && candidate.enum[0] === '')) ?? schema.anyOf[0];
    return exampleFromSchema(option, name, depth + 1);
  }

  switch (schema.type) {
    case 'string':
      return stringExample(schema, name);
    case 'number':
    case 'integer':
      return numberExample(schema);
    case 'boolean':
      return true;
    case 'array': {
      const count = Math.max(1, schema.minItems ?? 1);
      return Array.from({ length: count }, () => exampleFromSchema(schema.items ?? {}, name, depth + 1));
    }
    case 'object': {
      if (schema.properties) {
        return Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [key, exampleFromSchema(value, key, depth + 1)]),
        );
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return { key: exampleFromSchema(schema.additionalProperties, undefined, depth + 1) };
      }
      return {};
    }
    default:
      return name ? stringExample({ type: 'string' }, name) : null;
  }
}

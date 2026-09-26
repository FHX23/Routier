/**
 * Inferencia de cabeceras y parámetros de query a partir del cuerpo de un handler.
 * Cubre las APIs de Request/NextRequest, `next/headers`, Node/Express (`req.headers.x`,
 * `req.header('x')`, `req.get('x')`, `req.query.x`) y URLSearchParams.
 */

// Solo se consideran los nombres habituales del objeto request para no confundir, por ejemplo,
// la respuesta de un `fetch` (`res.headers.get(...)`) o `db.query.users` (Drizzle).
const REQ = String.raw`\b_?(?:req|request)\s*\??\.\s*`;
const QUOTED = String.raw`\s*['"\x60]([\w.-]+)['"\x60]\s*`;

const HEADER_OBJECT_METHODS = new Set(['get', 'has', 'set', 'append', 'delete', 'entries', 'keys', 'values', 'forEach']);

function canonicalHeader(name: string): string {
  return name.toLowerCase() === 'authorization' ? 'Authorization' : name;
}

function addUnique(list: string[], value: string) {
  if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) {
    list.push(value);
  }
}

function matchAll(code: string, pattern: string): string[] {
  return [...code.matchAll(new RegExp(pattern, 'g'))].map((match) => match[1]);
}

function destructuredKeys(list: string): string[] {
  return list
    .split(',')
    .map((part) => part.split(/[:=]/)[0].trim().replace(/^\.\.\./, '').replace(/['"`]/g, ''))
    .filter((key) => /^[\w$-]+$/.test(key));
}

export interface RequestInferenceOptions {
  /** Permite `req.get('x')` (Express). Desactivado por defecto porque `.get(` es muy genérico. */
  expressGetter?: boolean;
}

export function inferHeaders(handlerBody: string, options: RequestInferenceOptions = {}): string[] {
  const headers: string[] = [];
  const add = (name: string) => addUnique(headers, canonicalHeader(name));

  // req.headers.get('x') / request.headers['x'] / req.headers.authorization
  matchAll(handlerBody, `${REQ}headers\\s*\\.\\s*get\\s*\\(${QUOTED}\\)`).forEach(add);
  matchAll(handlerBody, `${REQ}headers\\s*\\[${QUOTED}\\]`).forEach(add);
  for (const name of matchAll(handlerBody, `${REQ}headers\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`)) {
    if (!HEADER_OBJECT_METHODS.has(name)) add(name);
  }

  // next/headers: headers().get('x') / (await headers()).get('x') / const h = await headers(); h.get('x')
  matchAll(handlerBody, `\\bheaders\\s*\\(\\s*\\)\\s*\\)?\\s*\\.\\s*get\\s*\\(${QUOTED}\\)`).forEach(add);
  for (const variable of matchAll(handlerBody, String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?headers\s*\(\s*\)`)) {
    const escaped = variable.replace(/\$/g, '\\$');
    matchAll(handlerBody, `\\b${escaped}\\s*\\.\\s*get\\s*\\(${QUOTED}\\)`).forEach(add);
  }

  // Express / Fastify: req.header('x'), req.get('x')
  matchAll(handlerBody, `${REQ}header\\s*\\(${QUOTED}\\)`).forEach(add);
  if (options.expressGetter) {
    matchAll(handlerBody, `${REQ}get\\s*\\(${QUOTED}\\)`).forEach(add);
  }

  // Destructuring: const { authorization } = req.headers
  for (const list of matchAll(handlerBody, `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${REQ}headers\\b`)) {
    destructuredKeys(list).forEach(add);
  }

  // Tokens Bearer leídos de forma indirecta.
  if (/['"`]Bearer\s/i.test(handlerBody)) add('Authorization');

  return headers;
}

export function inferQueryParams(handlerBody: string): string[] {
  const params: string[] = [];
  const add = (name: string) => addUnique(params, name);

  // URLSearchParams: searchParams.get('q'), url.searchParams.getAll('q')
  matchAll(handlerBody, `searchParams\\s*\\.\\s*(?:get|getAll|has)\\s*\\(${QUOTED}\\)`).forEach(add);
  for (const variable of matchAll(handlerBody, String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*searchParams\b(?!\s*\.)`)) {
    const escaped = variable.replace(/\$/g, '\\$');
    matchAll(handlerBody, `\\b${escaped}\\s*\\.\\s*(?:get|getAll|has)\\s*\\(${QUOTED}\\)`).forEach(add);
  }
  for (const list of matchAll(handlerBody, String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*Object\.fromEntries\s*\(\s*[\w$.]*searchParams`)) {
    destructuredKeys(list).forEach(add);
  }

  // Node / Express / Fastify / Pages Router: req.query.q, req.query['q'], const { q } = req.query
  matchAll(handlerBody, `${REQ}query\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`).forEach(add);
  matchAll(handlerBody, `${REQ}query\\s*\\[${QUOTED}\\]`).forEach(add);
  for (const list of matchAll(handlerBody, `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${REQ}query\\b`)) {
    destructuredKeys(list).forEach(add);
  }

  return params;
}

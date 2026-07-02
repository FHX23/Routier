import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import type { Endpoint, HttpMethod } from '../../types.js';

interface NextScanOptions {
  cwd?: string;
  exclude?: string[];
}


function extractZodObjectBlock(content: string, schemaName: string): string | null {
  const regex = new RegExp(`const\\s+${schemaName}\\s*=\\s*(z|zod)\\.object\\s*\\(\\s*\\{`);
  const match = content.match(regex);
  if (!match) return null;

  const startIndex = match.index! + match[0].length - 1;

  let braceCount = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
    } else if (content[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        return content.substring(startIndex, i + 1);
      }
    }
  }
  return null;
}

function splitProperties(content: string): string[] {
  const props: string[] = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '(') parenDepth++;
    else if (char === ')') parenDepth--;
    else if (char === '[') bracketDepth++;
    else if (char === ']') bracketDepth--;
    else if (char === '{') braceDepth++;
    else if (char === '}') braceDepth--;

    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      props.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    props.push(current.trim());
  }
  return props;
}

function inferTypeFromZodValue(valText: string): any {
  const trimmed = valText.trim();

  if (trimmed.startsWith('z.object') || trimmed.startsWith('zod.object') || trimmed.includes('z.object(') || trimmed.includes('zod.object(')) {
    const startIndex = trimmed.indexOf('{');
    if (startIndex !== -1) {
      let braceCount = 0;
      for (let i = startIndex; i < trimmed.length; i++) {
        if (trimmed[i] === '{') braceCount++;
        else if (trimmed[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            const nestedBlock = trimmed.substring(startIndex, i + 1);
            return parseZodObjectBlockContent(nestedBlock);
          }
        }
      }
    }
  }

  if (trimmed.includes('.array')) {
    const match = trimmed.match(/\.array\s*\(([\s\S]*)\)/);
    if (match) {
      return [inferTypeFromZodValue(match[1])];
    }
    return [];
  }

  if (trimmed.includes('.enum')) {
    const match = trimmed.match(/\.enum\s*\(\s*\[([\s\S]*?)\]\s*\)/);
    if (match) {
      const items = match[1].split(',').map((s) => s.trim().replace(/['"`]/g, ''));
      return items[0] ?? '';
    }
    return 'enum';
  }

  if (trimmed.includes('.string')) {
    if (trimmed.includes('.email')) {
      return 'user@example.com';
    }
    if (trimmed.includes('.uuid')) {
      return '123e4567-e89b-12d3-a456-426614174000';
    }
    return 'string';
  }

  if (trimmed.includes('.number')) {
    return 10;
  }

  if (trimmed.includes('.boolean')) {
    return true;
  }

  if (trimmed.includes('.date') || trimmed.includes('z.date')) {
    return '2026-07-02T00:00:00.000Z';
  }

  return null;
}

function parseZodObjectBlockContent(blockContent: string): Record<string, any> {
  const content = blockContent.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  const result: Record<string, any> = {};

  const properties = splitProperties(content);
  for (const prop of properties) {
    const colonIndex = prop.indexOf(':');
    if (colonIndex === -1) continue;
    const key = prop.substring(0, colonIndex).trim().replace(/['"`]/g, '');
    const valText = prop.substring(colonIndex + 1).trim();

    result[key] = inferTypeFromZodValue(valText);
  }

  return result;
}

function extractMethodBody(content: string, method: string): string | null {
  const regexes = [
    new RegExp(`export\\s+(async\\s+)?(function)\\s+${method}\\b`),
    new RegExp(`export\\s+const\\s+${method}\\b`),
  ];
  let matchIndex = -1;
  let matchLength = 0;
  for (const regex of regexes) {
    const m = content.match(regex);
    if (m) {
      matchIndex = m.index!;
      matchLength = m[0].length;
      break;
    }
  }
  if (matchIndex === -1) return null;

  const startIndex = content.indexOf('{', matchIndex + matchLength);
  if (startIndex === -1) return null;

  let braceCount = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') braceCount++;
    else if (content[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        return content.substring(startIndex, i + 1);
      }
    }
  }
  return null;
}

async function inferMetadataForMethod(
  fileContent: string,
  methodBody: string,
): Promise<{ headers?: string[]; body?: string }> {
  const headersSet = new Set<string>();

  const getMatches = methodBody.matchAll(/\.headers\.get\(['"`]([a-zA-Z0-9_-]+)['"`]\)/gi);
  for (const match of getMatches) {
    const name = match[1];
    headersSet.add(name.toLowerCase() === 'authorization' ? 'Authorization' : name);
  }

  const bracketMatches = methodBody.matchAll(/\.headers\[['"`]([a-zA-Z0-9_-]+)['"`]\]/gi);
  for (const match of bracketMatches) {
    const name = match[1];
    headersSet.add(name.toLowerCase() === 'authorization' ? 'Authorization' : name);
  }

  if (
    methodBody.toLowerCase().includes('authorization') ||
    methodBody.toLowerCase().includes('bearer') ||
    fileContent.toLowerCase().includes('authorization')
  ) {
    headersSet.add('Authorization');
  }

  const parseMatches = methodBody.matchAll(/([a-zA-Z0-9_]+)\.(safeP|p)arse\(/g);
  let bodyText: string | undefined;
  for (const match of parseMatches) {
    const schemaName = match[1];
    const zodBlock = extractZodObjectBlock(fileContent, schemaName);
    if (zodBlock) {
      try {
        const parsedBody = parseZodObjectBlockContent(zodBlock);
        bodyText = JSON.stringify(parsedBody, null, 2);
        break;
      } catch {
        // Ignorar fallos de parseo
      }
    }
  }

  return {
    headers: headersSet.size > 0 ? Array.from(headersSet) : undefined,
    body: bodyText,
  };
}

const STANDARD_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const DEFAULT_IGNORE = ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/routier-exports/**'];


function cleanNextPath(rawPath: string): string {
  let cleaned = rawPath.replace(/\\/g, '/');

  cleaned = cleaned.replace(/\/\([^)]+\)/g, '');
  cleaned = cleaned.replace(/\[\[\.\.\.([^\]]+)\]\]/g, ':$1');
  cleaned = cleaned.replace(/\[\.\.\.([^\]]+)\]/g, ':$1');
  cleaned = cleaned.replace(/\[([^\]]+)\]/g, ':$1');

  if (!cleaned.startsWith('/')) {
    cleaned = `/${cleaned}`;
  }

  return cleaned === '' ? '/' : cleaned;
}

async function extractAppRouterMethods(filePath: string): Promise<HttpMethod[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    
    // Limpiar comentarios de bloque y de línea para evitar falsos positivos
    const cleanContent = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const detectedMethods: HttpMethod[] = [];

    for (const method of STANDARD_METHODS) {
      const inlineRegex = new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${method}\\b`);
      const blockRegex = new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`);
      
      if (inlineRegex.test(cleanContent) || blockRegex.test(cleanContent)) {
        detectedMethods.push(method);
      }
    }

    return detectedMethods.length > 0 ? detectedMethods : ['GET'];
  } catch {
    return ['GET'];
  }
}

async function extractPagesRouterMethods(filePath: string): Promise<HttpMethod[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    
    // Limpiar comentarios de bloque y de línea para evitar falsos positivos
    const cleanContent = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const detectedMethods: HttpMethod[] = [];

    for (const method of STANDARD_METHODS) {
      const regexes = [
        new RegExp(`req\\.method\\s*===\\s*['"\`]${method}['"\`]`),
        new RegExp(`req\\.method\\s*==\\s*['"\`]${method}['"\`]`),
        new RegExp(`case\\s+['"\`]${method}['"\`]\\s*:`),
      ];
      if (regexes.some(r => r.test(cleanContent))) {
        detectedMethods.push(method);
      }
    }

    return detectedMethods.length > 0 ? detectedMethods : ['GET', 'POST'];
  } catch {
    return ['GET', 'POST'];
  }
}

export async function scanNextRoutes(options: NextScanOptions = {}): Promise<Endpoint[]> {
  const cwd = options.cwd ?? process.cwd();
  const endpoints: Endpoint[] = [];
  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];

  const appRouterFiles = await fg(['**/app/**/route.{ts,js}'], {
    cwd,
    ignore,
  });

  for (const file of appRouterFiles) {
    const rawRoute = file
      .replace(/\\/g, '/')
      .replace(/^.*?app/, '')
      .replace(/\/route\.(ts|js)$/, '');
    const cleanedPath = cleanNextPath(rawRoute === '' ? '/' : rawRoute);
    
    const isGraphQL = cleanedPath === '/api/graphql' || cleanedPath === '/graphql' || cleanedPath.endsWith('/graphql');
    const methods: HttpMethod[] = isGraphQL ? ['POST'] : await extractAppRouterMethods(`${cwd}/${file}`);

    const fileContent = await readFile(`${cwd}/${file}`, 'utf-8');
    const cleanContent = fileContent
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const methodsMetadata: Record<HttpMethod, { headers?: string[]; body?: string }> = {} as any;
    
    if (!isGraphQL) {
      for (const method of methods) {
        const methodBody = extractMethodBody(cleanContent, method) ?? cleanContent;
        const meta = await inferMetadataForMethod(cleanContent, methodBody);
        if (meta.headers || meta.body) {
          methodsMetadata[method] = meta;
        }
      }
    }

    endpoints.push({
      path: cleanedPath,
      methods,
      fileType: isGraphQL ? 'graphql' : 'rest',
      sourceFile: file.replace(/\\/g, '/'),
      router: 'app',
      methodsMetadata: Object.keys(methodsMetadata).length > 0 ? methodsMetadata : undefined,
    });
  }

  const pagesRouterFiles = await fg(['**/pages/api/**/*.{ts,js}'], {
    cwd,
    ignore,
  });

  for (const file of pagesRouterFiles) {
    let rawRoute = file
      .replace(/\\/g, '/')
      .replace(/^.*?pages/, '')
      .replace(/\.(ts|js)$/, '');

    if (rawRoute.endsWith('/index')) {
      rawRoute = rawRoute.slice(0, -6);
    }

    const cleanedPath = cleanNextPath(rawRoute);
    const isGraphQL = cleanedPath === '/api/graphql' || cleanedPath === '/graphql' || cleanedPath.endsWith('/graphql');
    const methods: HttpMethod[] = isGraphQL ? ['POST'] : await extractPagesRouterMethods(`${cwd}/${file}`);

    const fileContent = await readFile(`${cwd}/${file}`, 'utf-8');
    const cleanContent = fileContent
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const methodsMetadata: Record<HttpMethod, { headers?: string[]; body?: string }> = {} as any;

    if (!isGraphQL) {
      for (const method of methods) {
        const meta = await inferMetadataForMethod(cleanContent, cleanContent);
        const cleanMeta = { ...meta };
        if (!['POST', 'PUT', 'PATCH'].includes(method)) {
          delete cleanMeta.body;
        }
        if (cleanMeta.headers || cleanMeta.body) {
          methodsMetadata[method] = cleanMeta;
        }
      }
    }

    endpoints.push({
      path: cleanedPath,
      methods,
      fileType: isGraphQL ? 'graphql' : 'rest',
      sourceFile: file.replace(/\\/g, '/'),
      router: 'pages',
      methodsMetadata: Object.keys(methodsMetadata).length > 0 ? methodsMetadata : undefined,
    });
  }

  return endpoints.sort((a, b) => a.path.localeCompare(b.path));
}

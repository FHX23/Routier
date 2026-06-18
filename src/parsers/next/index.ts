import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import type { Endpoint, HttpMethod } from '../../types.js';

interface NextScanOptions {
  cwd?: string;
}

const STANDARD_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

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
    const detectedMethods: HttpMethod[] = [];

    for (const method of STANDARD_METHODS) {
      const regex = new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${method}\\b`);
      if (regex.test(content)) {
        detectedMethods.push(method);
      }
    }

    return detectedMethods.length > 0 ? detectedMethods : ['GET'];
  } catch {
    return ['GET'];
  }
}

export async function scanNextRoutes(options: NextScanOptions = {}): Promise<Endpoint[]> {
  const cwd = options.cwd ?? process.cwd();
  const endpoints: Endpoint[] = [];

  const appRouterFiles = await fg(['**/app/**/route.{ts,js}'], {
    cwd,
    ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/routier-exports/**'],
  });

  for (const file of appRouterFiles) {
    const rawRoute = file
      .replace(/\\/g, '/')
      .replace(/^.*?app/, '')
      .replace(/\/route\.(ts|js)$/, '');
    const cleanedPath = cleanNextPath(rawRoute === '' ? '/' : rawRoute);
    const methods = await extractAppRouterMethods(`${cwd}/${file}`);

    endpoints.push({
      path: cleanedPath,
      methods,
      fileType: cleanedPath.includes('graphql') ? 'graphql' : 'rest',
      sourceFile: file.replace(/\\/g, '/'),
      router: 'app',
    });
  }

  const pagesRouterFiles = await fg(['**/pages/api/**/*.{ts,js}'], {
    cwd,
    ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/routier-exports/**'],
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

    endpoints.push({
      path: cleanedPath,
      methods: cleanedPath.includes('graphql') ? ['POST'] : ['GET', 'POST'],
      fileType: cleanedPath.includes('graphql') ? 'graphql' : 'rest',
      sourceFile: file.replace(/\\/g, '/'),
      router: 'pages',
    });
  }

  return endpoints.sort((a, b) => a.path.localeCompare(b.path));
}

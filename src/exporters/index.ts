import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateInsomniaExport } from './insomnia.js';
import { generatePostmanCollection } from './postman.js';
import { generateOpenAPI } from '../generators/openapi.js';
import type { ScanResult } from '../types.js';

export type ExportFormat = 'postman' | 'insomnia' | 'openapi' | 'all';
export type GroupBy = 'type' | 'method' | 'path' | 'none';
export type SortMode = 'alpha' | 'none';

interface WriteExportsOptions {
  cwd: string;
  outDir: string;
  format: ExportFormat;
  baseUrl: string;
  groupBy: GroupBy;
  sort: SortMode;
}

export async function writeExports(scan: ScanResult, options: WriteExportsOptions): Promise<string[]> {
  const outputDir = path.resolve(options.cwd, options.outDir);
  await mkdir(outputDir, { recursive: true });

  const writtenFiles: string[] = [];
  const formats = options.format === 'all' 
    ? (['postman', 'insomnia', 'openapi'] as const) 
    : [options.format];

  // Generar OpenAPI centralizado (fuente de verdad para el resto de formatos)
  const project = await readProjectInfo(options.cwd);
  const openapiObj = generateOpenAPI(scan, { baseUrl: options.baseUrl, ...project });

  if (formats.includes('openapi')) {
    const file = path.join(outputDir, 'routier-openapi.json');
    await writeFile(file, `${JSON.stringify(openapiObj, null, 2)}\n`);
    writtenFiles.push(file);
  }

  if (formats.includes('postman')) {
    const file = path.join(outputDir, 'routier-postman.json');
    await writeFile(file, `${JSON.stringify(generatePostmanCollection(openapiObj, {
      baseUrl: options.baseUrl,
      groupBy: options.groupBy,
      sort: options.sort,
    }), null, 2)}\n`);
    writtenFiles.push(file);
  }

  if (formats.includes('insomnia')) {
    const file = path.join(outputDir, 'routier-insomnia.json');
    await writeFile(file, `${JSON.stringify(generateInsomniaExport(openapiObj, {
      baseUrl: options.baseUrl,
      groupBy: options.groupBy,
      sort: options.sort,
    }), null, 2)}\n`);
    writtenFiles.push(file);
  }

  return writtenFiles;
}

/** Toma nombre y versión del `package.json` del proyecto analizado, si existe. */
async function readProjectInfo(cwd: string): Promise<{ title?: string; version?: string }> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    return {
      title: typeof pkg.name === 'string' ? `${pkg.name} API` : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
    };
  } catch {
    return {};
  }
}

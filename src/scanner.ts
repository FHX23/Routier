import path from 'node:path';
import { scanGraphQLSchema } from './parsers/graphql/index.js';
import { detectFrameworks, runAdapters } from './parsers/index.js';
import type { ScanOptions, ScanResult } from './types.js';

export async function scanProject(options: ScanOptions = {}): Promise<ScanResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const frameworks = !options.framework || options.framework === 'auto'
    ? await detectFrameworks(cwd)
    : [options.framework];

  const [rest, graphql] = await Promise.all([
    runAdapters(frameworks, { cwd, exclude: options.exclude }),
    scanGraphQLSchema({ cwd, schemaPath: options.graphqlSchema, exclude: options.exclude }),
  ]);

  return {
    endpoints: rest.endpoints,
    graphqlOperations: graphql.operations,
    warnings: [...rest.warnings, ...graphql.warnings],
  };
}

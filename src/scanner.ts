import { scanGraphQLSchema } from './parsers/graphql/index.js';
import { scanNextRoutes } from './parsers/next/index.js';
import type { ScanOptions, ScanResult } from './types.js';

export async function scanProject(options: ScanOptions = {}): Promise<ScanResult> {
  const cwd = options.cwd ?? process.cwd();
  const endpoints = await scanNextRoutes({ cwd });
  const graphql = await scanGraphQLSchema({ cwd, schemaPath: options.graphqlSchema });

  return {
    endpoints,
    graphqlOperations: graphql.operations,
    warnings: graphql.warnings,
  };
}

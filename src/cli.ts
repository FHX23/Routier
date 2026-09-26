#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { log } from '@clack/prompts';
import { Command, Option } from 'commander';
import color from 'picocolors';
import { writeExports, type ExportFormat, type GroupBy, type SortMode } from './exporters/index.js';
import { scanProject } from './scanner.js';
import {
  SUPPORTED_FORMATS,
  SUPPORTED_FRAMEWORKS,
  SUPPORTED_GROUP_BY,
  SUPPORTED_SORT,
  resolveConfig,
  validateConfig,
} from './config.js';
import type { RoutierConfig } from './types.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

interface CommonOptions {
  cwd?: string;
  framework?: string;
  graphqlSchema?: string;
  exclude?: string[];
  interactive?: boolean;
}

interface ScanOptions extends CommonOptions {
  json?: boolean;
}

interface ExportOptions extends CommonOptions {
  format?: string;
  groupBy?: string;
  sort?: string;
  out?: string;
  baseUrl?: string;
}

async function loadResolvedConfig(cwd: string, cliOptions: Partial<RoutierConfig>, interactive: boolean) {
  const config = await resolveConfig(cwd, cliOptions, { interactive });
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return config;
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log.error(message);
  process.exitCode = 1;
}

const program = new Command();

program
  .name('routier')
  .description('Scan Next.js, Express, Fastify, NestJS and GraphQL projects and generate OpenAPI, Postman and Insomnia collections.')
  .version(version, '-v, --version', 'Print the Routier version')
  .helpCommand('help [command]', 'Show help for a command')
  .addHelpText('after', `
Examples:
  $ routier scan
  $ routier scan --json > routes.json
  $ routier export --format all --base-url http://localhost:3000
  $ routier export --format postman --group-by method --out ./collections

Docs: https://github.com/FHX23/Routier#readme`);

program
  .command('scan')
  .description('List the REST endpoints and GraphQL operations found in a project')
  .option('--cwd <path>', 'Project directory', '.')
  .addOption(new Option('--framework <framework>', 'Framework to scan (default: auto)').choices([...SUPPORTED_FRAMEWORKS]))
  .option('--graphql-schema <path>', 'Explicit GraphQL schema file (.graphql or .gql)')
  .option('--exclude <globs...>', 'Glob patterns to skip (e.g. "**/mocks/**")')
  .option('--json', 'Print the scan result as JSON (implies --no-interactive)')
  .option('--no-interactive', 'Never prompt to create routier.json')
  .addHelpText('after', `
Examples:
  $ routier scan
  $ routier scan --cwd ./apps/api --framework express
  $ routier scan --graphql-schema ./schema.graphql
  $ routier scan --json --exclude "**/mocks/**"`)
  .action(async (options: ScanOptions) => {
    try {
      const cwd = path.resolve(options.cwd ?? '.');
      const interactive = options.interactive !== false && !options.json;
      const config = await loadResolvedConfig(cwd, {
        framework: options.framework as RoutierConfig['framework'],
        graphqlSchema: options.graphqlSchema,
        exclude: options.exclude,
      }, interactive);

      const result = await scanProject({
        cwd,
        framework: config.framework,
        graphqlSchema: config.graphqlSchema,
        exclude: config.exclude,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      log.info(color.cyan(`REST endpoints found: ${result.endpoints.length}`));
      for (const endpoint of result.endpoints) {
        log.step(`${endpoint.methods.join(', ')} ${endpoint.path} ${color.dim(`(${endpoint.router}) ${endpoint.sourceFile}`)}`);
      }

      log.info(color.magenta(`GraphQL operations found: ${result.graphqlOperations.length}`));
      for (const operation of result.graphqlOperations) {
        log.step(`${operation.type} ${operation.name} ${color.dim(operation.sourceFile)}`);
      }

      for (const warning of result.warnings) {
        log.warn(warning);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command('export')
  .description('Generate OpenAPI, Postman and/or Insomnia files')
  .option('--cwd <path>', 'Project directory', '.')
  .addOption(new Option('--framework <framework>', 'Framework to scan (default: auto)').choices([...SUPPORTED_FRAMEWORKS]))
  .addOption(new Option('--format <format>', 'Output format (default: all)').choices([...SUPPORTED_FORMATS]))
  .addOption(new Option('--group-by <mode>', 'Folder grouping for collections (default: type)').choices([...SUPPORTED_GROUP_BY]))
  .addOption(new Option('--sort <mode>', 'Request ordering (default: alpha)').choices([...SUPPORTED_SORT]))
  .option('--out <path>', 'Output directory, relative to --cwd (default: ./routier-exports)')
  .option('--base-url <url>', 'Base URL for requests (default: {{baseUrl}} variable)')
  .option('--graphql-schema <path>', 'Explicit GraphQL schema file (.graphql or .gql)')
  .option('--exclude <globs...>', 'Glob patterns to skip (e.g. "**/mocks/**")')
  .option('--no-interactive', 'Never prompt to create routier.json')
  .addHelpText('after', `
Examples:
  $ routier export
  $ routier export --format openapi
  $ routier export --format postman --group-by method --sort alpha
  $ routier export --cwd ./app --out ./collections --base-url http://localhost:3000`)
  .action(async (options: ExportOptions) => {
    try {
      const cwd = path.resolve(options.cwd ?? '.');
      const config = await loadResolvedConfig(cwd, {
        framework: options.framework as RoutierConfig['framework'],
        format: options.format as RoutierConfig['format'],
        groupBy: options.groupBy as RoutierConfig['groupBy'],
        sort: options.sort as RoutierConfig['sort'],
        out: options.out,
        baseUrl: options.baseUrl,
        graphqlSchema: options.graphqlSchema,
        exclude: options.exclude,
      }, options.interactive !== false);

      const result = await scanProject({
        cwd,
        framework: config.framework,
        graphqlSchema: config.graphqlSchema,
        exclude: config.exclude,
      });

      const writtenFiles = await writeExports(result, {
        cwd,
        outDir: config.out ?? './routier-exports',
        format: (config.format ?? 'all') as ExportFormat,
        baseUrl: config.baseUrl ?? '{{baseUrl}}',
        groupBy: (config.groupBy ?? 'type') as GroupBy,
        sort: (config.sort ?? 'alpha') as SortMode,
      });

      log.info(`${result.endpoints.length} REST endpoints, ${result.graphqlOperations.length} GraphQL operations`);
      for (const file of writtenFiles) {
        log.success(`Written ${path.relative(process.cwd(), file) || file}`);
      }

      for (const warning of result.warnings) {
        log.warn(warning);
      }
    } catch (error) {
      fail(error);
    }
  });

await program.parseAsync(process.argv);

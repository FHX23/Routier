#!/usr/bin/env node
import { log } from '@clack/prompts';
import { Command } from 'commander';
import color from 'picocolors';
import { writeExports, type ExportFormat, type GroupBy, type SortMode } from './exporters/index.js';
import { scanProject } from './scanner.js';
import { resolveConfig } from './config.js';

const program = new Command();

program
  .name('routier')
  .description('CLI para analizar Next.js, GraphQL y generar colecciones para Postman e Insomnia\n\nUso rápido:\n  routier scan --cwd ./myproject\n  routier export --cwd ./myproject --format all --group-by type')
  .version('0.1.2')
  .addHelpCommand('help [command]', 'Muestra ayuda para un comando')
  .on('--help', () => {
    console.log('\nEjemplos:\n');
    console.log('  $ routier scan --cwd .');
    console.log('  $ routier export --cwd . --format postman --group-by type --sort alpha');
    console.log('  $ routier export --cwd . --format insomnia --out ./exports');
    console.log('\nMás información: https://github.com/FHX23/Routier');
  });

program
  .command('scan')
  .description('Escanea el proyecto en busca de rutas REST y operaciones GraphQL')
  .option('--cwd <path>', 'Directorio del proyecto')
  .option('--graphql-schema <path>', 'Ruta explícita al schema GraphQL (.graphql o .gql)')
  .addHelpText('after', '\nEjemplos:\n  $ routier scan\n  $ routier scan --cwd ./src\n  $ routier scan --graphql-schema ./schema.graphql')
  .action(async (options: { cwd?: string; graphqlSchema?: string }) => {
    try {
      const cwd = options.cwd ?? '.';
      const config = await resolveConfig(cwd, options);

      const result = await scanProject({
        cwd,
        graphqlSchema: config.graphqlSchema,
        exclude: config.exclude,
      });

      log.info(color.cyan(`REST/HTTP endpoints detectados: ${result.endpoints.length}`));
      for (const endpoint of result.endpoints) {
        log.step(`${endpoint.methods.join(', ')} ${endpoint.path} (${endpoint.router}) - ${endpoint.sourceFile}`);
      }

      log.info(color.magenta(`Operaciones GraphQL detectadas: ${result.graphqlOperations.length}`));
      for (const operation of result.graphqlOperations) {
        log.step(`${operation.type} ${operation.name} - ${operation.sourceFile}`);
      }

      for (const warning of result.warnings) {
        log.warn(warning);
      }
    } catch (error) {
      log.error(String(error));
      process.exitCode = 1;
    }
  });

program
  .command('export')
  .description('Genera archivos importables en Postman e Insomnia')
  .option('--cwd <path>', 'Directorio del proyecto')
  .option('--framework <framework>', 'Framework soportado: next')
  .option('--format <format>', 'Formatos: postman | insomnia | all')
  .option('--group-by <mode>', 'Agrupar por: type | method | path | none')
  .option('--sort <mode>', 'Ordenar por: alpha | none')
  .option('--out <path>', 'Directorio de salida')
  .option('--base-url <url>', 'Base URL para requests')
  .option('--graphql-schema <path>', 'Ruta explícita al schema GraphQL')
  .addHelpText('after', '\nEjemplos:\n  $ routier export\n  $ routier export --format postman --group-by type --sort alpha\n  $ routier export --cwd ./app --out ./collections --base-url http://localhost:3000\n  $ routier export --format insomnia --group-by none')
  .action(async (options: {
    cwd?: string;
    framework?: string;
    format?: string;
    groupBy?: string;
    sort?: string;
    out?: string;
    baseUrl?: string;
    graphqlSchema?: string;
  }) => {
    try {
      const cwd = options.cwd ?? '.';
      const config = await resolveConfig(cwd, options as any);

      // Aplicar valores predeterminados finales después de resolver la configuración
      const framework = config.framework ?? 'next';
      const format = config.format ?? 'all';
      const groupBy = config.groupBy ?? 'type';
      const sort = config.sort ?? 'alpha';
      const out = config.out ?? './routier-exports';
      const baseUrl = config.baseUrl ?? '{{baseUrl}}';
      const graphqlSchema = config.graphqlSchema;
      const exclude = config.exclude;

      if (framework !== 'next') {
        throw new Error('El MVP solo soporta --framework next.');
      }

      if (!['postman', 'insomnia', 'openapi', 'all'].includes(format)) {
        throw new Error('--format debe ser postman, insomnia, openapi o all.');
      }

      if (!['type', 'method', 'path', 'none'].includes(groupBy)) {
        throw new Error('--group-by debe ser type, method, path o none.');
      }

      if (!['alpha', 'none'].includes(sort)) {
        throw new Error('--sort debe ser alpha o none.');
      }

      const result = await scanProject({
        cwd,
        graphqlSchema,
        exclude,
      });

      const writtenFiles = await writeExports(result, {
        cwd,
        outDir: out,
        format: format as ExportFormat,
        baseUrl,
        groupBy: groupBy as GroupBy,
        sort: sort as SortMode,
      });

      for (const file of writtenFiles) {
        log.success(`Archivo generado: ${file}`);
      }

      for (const warning of result.warnings) {
        log.warn(warning);
      }
    } catch (error) {
      log.error(String(error));
      process.exitCode = 1;
    }
  });

program.parse(process.argv);

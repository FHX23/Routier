#!/usr/bin/env node
import { log } from '@clack/prompts';
import { Command } from 'commander';
import color from 'picocolors';
import { writeExports, type ExportFormat, type GroupBy, type SortMode } from './exporters/index.js';
import { scanProject } from './scanner.js';

const program = new Command();

program
  .name('routier')
  .description('Analiza proyectos Next.js y exporta colecciones para Postman e Insomnia')
  .version('1.0.0');

program
  .command('scan')
  .description('Escanea el proyecto en busca de rutas y operaciones GraphQL')
  .option('--cwd <path>', 'Directorio del proyecto a escanear', '.')
  .option('--graphql-schema <path>', 'Ruta explicita a schema GraphQL')
  .action(async (options: { cwd: string; graphqlSchema?: string }) => {
    try {
      const result = await scanProject({ cwd: options.cwd, graphqlSchema: options.graphqlSchema });

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
  .option('--cwd <path>', 'Directorio del proyecto a escanear', '.')
  .option('--framework <framework>', 'Framework a escanear', 'next')
  .option('--format <format>', 'postman, insomnia o all', 'all')
  .option('--group-by <mode>', 'type, method, path o none', 'type')
  .option('--sort <mode>', 'alpha o none', 'alpha')
  .option('--out <path>', 'Directorio de salida', './routier-exports')
  .option('--base-url <url>', 'Base URL para las requests', '{{baseUrl}}')
  .option('--graphql-schema <path>', 'Ruta explicita a schema GraphQL')
  .action(async (options: {
    cwd: string;
    framework: string;
    format: ExportFormat;
    groupBy: GroupBy;
    sort: SortMode;
    out: string;
    baseUrl: string;
    graphqlSchema?: string;
  }) => {
    try {
      if (options.framework !== 'next') {
        throw new Error('El MVP solo soporta --framework next.');
      }

      if (!['postman', 'insomnia', 'all'].includes(options.format)) {
        throw new Error('--format debe ser postman, insomnia o all.');
      }

      if (!['type', 'method', 'path', 'none'].includes(options.groupBy)) {
        throw new Error('--group-by debe ser type, method, path o none.');
      }

      if (!['alpha', 'none'].includes(options.sort)) {
        throw new Error('--sort debe ser alpha o none.');
      }

      const result = await scanProject({ cwd: options.cwd, graphqlSchema: options.graphqlSchema });
      const writtenFiles = await writeExports(result, {
        cwd: options.cwd,
        outDir: options.out,
        format: options.format,
        baseUrl: options.baseUrl,
        groupBy: options.groupBy,
        sort: options.sort,
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

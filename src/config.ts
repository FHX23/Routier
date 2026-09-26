import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { confirm, select, text, intro, outro, log, isCancel, cancel } from '@clack/prompts';
import color from 'picocolors';
import type { RoutierConfig } from './types.js';

export const CONFIG_FILE = 'routier.json';

export const SUPPORTED_FRAMEWORKS = ['next'] as const;
export const SUPPORTED_FORMATS = ['all', 'openapi', 'postman', 'insomnia'] as const;
export const SUPPORTED_GROUP_BY = ['type', 'method', 'path', 'none'] as const;
export const SUPPORTED_SORT = ['alpha', 'none'] as const;

function handleCancel<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }
}

export async function loadConfig(cwd: string): Promise<RoutierConfig | null> {
  const configFilePath = path.join(cwd, CONFIG_FILE);
  try {
    const raw = await readFile(configFilePath, 'utf-8');
    return JSON.parse(raw) as RoutierConfig;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null;
    }
    log.warn(color.yellow(`Could not parse ${CONFIG_FILE}: ${error.message}`));
    return null;
  }
}

/** Valida los valores de la configuración resuelta y devuelve una lista de errores legibles. */
export function validateConfig(config: RoutierConfig): string[] {
  const errors: string[] = [];
  const check = (key: keyof RoutierConfig, flag: string, allowed: readonly string[]) => {
    const value = config[key];
    if (value !== undefined && !allowed.includes(value as string)) {
      errors.push(`Invalid ${flag} "${String(value)}". Expected one of: ${allowed.join(', ')}.`);
    }
  };

  check('framework', '--framework', SUPPORTED_FRAMEWORKS);
  check('format', '--format', SUPPORTED_FORMATS);
  check('groupBy', '--group-by', SUPPORTED_GROUP_BY);
  check('sort', '--sort', SUPPORTED_SORT);

  if (config.exclude !== undefined && (!Array.isArray(config.exclude) || config.exclude.some((item) => typeof item !== 'string'))) {
    errors.push('"exclude" must be an array of glob strings.');
  }
  for (const key of ['out', 'baseUrl', 'graphqlSchema'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      errors.push(`"${key}" must be a string.`);
    }
  }

  return errors;
}

export async function createInteractiveConfig(cwd: string): Promise<RoutierConfig | null> {
  intro(color.cyan('Routier setup'));

  const wantConfig = await confirm({
    message: `No ${CONFIG_FILE} found. Do you want to create one now?`,
    initialValue: true,
  });
  handleCancel(wantConfig);

  if (!wantConfig) {
    outro(color.yellow(`Skipped. No ${CONFIG_FILE} was created.`));
    return null;
  }

  const framework = await select({
    message: 'Project framework:',
    options: [
      { value: 'next', label: 'Next.js (App Router and Pages Router)' },
    ],
    initialValue: 'next',
  });
  handleCancel(framework);

  const out = await text({
    message: 'Output directory for exported collections:',
    placeholder: './routier-exports',
    initialValue: './routier-exports',
  });
  handleCancel(out);

  const baseUrl = await text({
    message: 'Base URL for API requests:',
    placeholder: '{{baseUrl}}',
    initialValue: '{{baseUrl}}',
  });
  handleCancel(baseUrl);

  const hasGraphql = await confirm({
    message: 'Does your project use an explicit GraphQL schema file?',
    initialValue: false,
  });
  handleCancel(hasGraphql);

  let graphqlSchema: string | undefined = undefined;
  if (hasGraphql) {
    const schemaPath = await text({
      message: 'Path to the GraphQL schema (e.g. schema.graphql):',
      placeholder: 'schema.graphql',
      initialValue: 'schema.graphql',
    });
    handleCancel(schemaPath);
    graphqlSchema = schemaPath;
  }

  const config: RoutierConfig = {
    framework,
    out,
    baseUrl,
    ...(graphqlSchema ? { graphqlSchema } : {}),
  };

  const configFilePath = path.join(cwd, CONFIG_FILE);
  await writeFile(configFilePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  outro(color.green(`${CONFIG_FILE} created.`));
  return config;
}

export interface ResolveConfigOptions {
  /** Permite abrir el asistente cuando no hay configuración ni flags. Por defecto, solo en una terminal interactiva. */
  interactive?: boolean;
}

/**
 * Combina `routier.json` con las opciones de la CLI (la CLI tiene prioridad).
 * Si no hay archivo ni flags y la terminal es interactiva, ofrece crear la configuración.
 */
export async function resolveConfig(
  cwd: string,
  cliOptions: Partial<RoutierConfig>,
  options: ResolveConfigOptions = {},
): Promise<RoutierConfig> {
  const definedCliOptions = Object.fromEntries(
    Object.entries(cliOptions).filter(([, value]) => value !== undefined),
  ) as Partial<RoutierConfig>;

  const fileConfig = await loadConfig(cwd);
  if (fileConfig) {
    return { ...fileConfig, ...definedCliOptions };
  }

  const hasCliOptions = Object.keys(definedCliOptions).length > 0;
  const isTTY = Boolean(process.stdout?.isTTY && process.stdin?.isTTY);
  const interactive = options.interactive ?? isTTY;

  if (!hasCliOptions && interactive && isTTY) {
    const interactiveConfig = await createInteractiveConfig(cwd);
    if (interactiveConfig) {
      return { ...interactiveConfig, ...definedCliOptions };
    }
  }

  return definedCliOptions;
}

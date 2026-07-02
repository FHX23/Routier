import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { confirm, select, text, intro, outro, log, isCancel, cancel } from '@clack/prompts';
import color from 'picocolors';
import type { RoutierConfig } from './types.js';

function handleCancel<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Operación cancelada.');
    process.exit(0);
  }
}

export async function loadConfig(cwd: string): Promise<RoutierConfig | null> {
  const configFilePath = path.join(cwd, 'routier.json');
  try {
    const raw = await readFile(configFilePath, 'utf-8');
    return JSON.parse(raw) as RoutierConfig;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null;
    }
    log.warn(color.yellow(`Advertencia: Error al parsear routier.json: ${error.message}`));
    return null;
  }
}

export async function createInteractiveConfig(cwd: string): Promise<RoutierConfig | null> {
  intro(color.cyan('Configuración de Routier'));

  const wantConfig = await confirm({
    message: 'No se encontró el archivo routier.json. ¿Deseas crearlo ahora?',
    initialValue: true,
  });
  handleCancel(wantConfig);

  if (!wantConfig) {
    outro(color.yellow('Asistente finalizado. No se creó el archivo de configuración.'));
    return null;
  }

  const framework = await select({
    message: 'Framework de tu proyecto:',
    options: [
      { value: 'next', label: 'Next.js (App Router y Pages Router)' }
    ],
    initialValue: 'next',
  });
  handleCancel(framework);

  const out = await text({
    message: 'Directorio de salida para colecciones exportadas:',
    placeholder: './routier-exports',
    initialValue: './routier-exports',
  });
  handleCancel(out);

  const baseUrl = await text({
    message: 'URL base de las llamadas API:',
    placeholder: '{{baseUrl}}',
    initialValue: '{{baseUrl}}',
  });
  handleCancel(baseUrl);

  const hasGraphql = await confirm({
    message: '¿Tu proyecto utiliza un esquema de GraphQL explícito?',
    initialValue: false,
  });
  handleCancel(hasGraphql);

  let graphqlSchema: string | undefined = undefined;
  if (hasGraphql) {
    const schemaPath = await text({
      message: 'Ruta al esquema GraphQL (ej. schema.graphql):',
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

  const configFilePath = path.join(cwd, 'routier.json');
  await writeFile(configFilePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  outro(color.green('¡Perfecto! Archivo routier.json creado exitosamente.'));
  return config;
}

export async function resolveConfig(cwd: string, cliOptions: Partial<RoutierConfig>): Promise<RoutierConfig> {
  const fileConfig = await loadConfig(cwd);

  if (fileConfig) {
    const merged: RoutierConfig = { ...fileConfig };
    for (const key of Object.keys(cliOptions) as Array<keyof RoutierConfig>) {
      if (cliOptions[key] !== undefined) {
        merged[key] = cliOptions[key] as any;
      }
    }
    return merged;
  }

  const hasCliOptions = Object.entries(cliOptions)
    .filter(([key]) => key !== 'cwd')
    .some(([_, val]) => val !== undefined);

  const isInteractive = process.stdout?.isTTY && process.stdin?.isTTY;

  if (!hasCliOptions && isInteractive) {
    const interactiveConfig = await createInteractiveConfig(cwd);
    if (interactiveConfig) {
      return { ...interactiveConfig, ...cliOptions };
    }
  }

  return cliOptions;
}

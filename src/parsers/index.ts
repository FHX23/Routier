import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Endpoint, Framework } from '../types.js';
import { scanExpressRoutes } from './express/index.js';
import { scanFastifyRoutes } from './fastify/index.js';
import { scanNestRoutes } from './nestjs/index.js';
import { scanNextRoutes } from './next/index.js';

export const FRAMEWORKS: readonly Framework[] = ['next', 'express', 'fastify', 'nestjs'];

export interface AdapterOptions {
  cwd: string;
  exclude?: string[];
}

export interface AdapterResult {
  endpoints: Endpoint[];
  warnings: string[];
}

type Adapter = (options: AdapterOptions) => Promise<AdapterResult>;

const ADAPTERS: Record<Framework, Adapter> = {
  next: async (options) => ({ endpoints: await scanNextRoutes(options), warnings: [] }),
  express: scanExpressRoutes,
  fastify: scanFastifyRoutes,
  nestjs: scanNestRoutes,
};

/**
 * Detecta los frameworks usados leyendo las dependencias del `package.json` del proyecto.
 * Si no hay `package.json` o no declara ningún framework conocido (p. ej. la raíz de un
 * monorepo), devuelve todos para que cada adapter busque sus propios patrones.
 */
export async function detectFrameworks(cwd: string): Promise<Framework[]> {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf-8'));
    deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    return [...FRAMEWORKS];
  }

  const found: Framework[] = [];
  if (deps.next) found.push('next');
  if (deps['@nestjs/core']) {
    // NestJS corre sobre Express o Fastify: sus rutas se leen de los controladores.
    found.push('nestjs');
  } else {
    if (deps.express) found.push('express');
    if (deps.fastify) found.push('fastify');
  }

  return found.length > 0 ? found : [...FRAMEWORKS];
}

export async function runAdapters(frameworks: Framework[], options: AdapterOptions): Promise<AdapterResult> {
  const results = await Promise.all(frameworks.map((framework) => ADAPTERS[framework](options)));
  const endpoints: Endpoint[] = [];
  const seen = new Map<string, Endpoint>();

  for (const endpoint of results.flatMap((result) => result.endpoints)) {
    // Un mismo archivo puede coincidir con patrones de más de un adapter (p. ej. Express y Fastify comparten `app.get`).
    const key = `${endpoint.path} ${endpoint.sourceFile}`;
    const existing = seen.get(key);
    if (existing) {
      for (const method of endpoint.methods) {
        if (!existing.methods.includes(method)) existing.methods.push(method);
      }
      continue;
    }
    seen.set(key, endpoint);
    endpoints.push(endpoint);
  }

  return {
    endpoints: endpoints.sort((a, b) => a.path.localeCompare(b.path)),
    warnings: results.flatMap((result) => result.warnings),
  };
}

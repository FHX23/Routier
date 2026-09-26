import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { detectFrameworks } from '../src/parsers/index.js';
import { scanProject } from '../src/scanner.js';
import { generateOpenAPI } from '../src/generators/openapi.js';

const fixture = (name: string) => path.resolve('tests/fixtures', name);

test('detectFrameworks reads package.json and falls back to every adapter', async () => {
  assert.deepEqual(await detectFrameworks(fixture('express-app')), ['express']);
  assert.deepEqual(await detectFrameworks(fixture('fastify-app')), ['fastify']);
  assert.deepEqual(await detectFrameworks(fixture('nest-app')), ['nestjs']);
  assert.deepEqual(await detectFrameworks(fixture('next-app')), ['next', 'express', 'fastify', 'nestjs']);
});

test('scanProject auto-detects the framework and honours an explicit one', async () => {
  const express = await scanProject({ cwd: fixture('express-app') });
  assert.equal(express.endpoints.every((endpoint) => endpoint.router === 'express'), true);

  const forcedNext = await scanProject({ cwd: fixture('express-app'), framework: 'next' });
  assert.equal(forcedNext.endpoints.length, 0);

  const next = await scanProject({ cwd: fixture('next-app') });
  assert.equal(next.endpoints.every((endpoint) => endpoint.router === 'app' || endpoint.router === 'pages'), true);
});

test('every framework fixture produces an OpenAPI document with the expected operations', async () => {
  const cases: [string, string, string][] = [
    ['express-app', '/api/users/{id}', 'delete'],
    ['fastify-app', '/api/users/{id}', 'patch'],
    ['nest-app', '/api/v2/users/{id}', 'patch'],
  ];

  for (const [name, route, method] of cases) {
    const scan = await scanProject({ cwd: fixture(name) });
    const openapi = generateOpenAPI(scan, { baseUrl: 'http://localhost:3000' });
    const operation = openapi.paths[route]?.[method];
    assert.ok(operation, `${name}: ${method.toUpperCase()} ${route}`);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }], `${name}: auth`);
  }
});

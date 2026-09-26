import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanFastifyRoutes } from '../src/parsers/fastify/index.js';

const fixture = path.resolve('tests/fixtures/fastify-app');

async function byPath() {
  const { endpoints } = await scanFastifyRoutes({ cwd: fixture });
  return new Map(endpoints.map((endpoint) => [endpoint.path, endpoint]));
}

test('applies plugin prefixes from imported, inline and autoloaded plugins', async () => {
  const routes = await byPath();

  assert.deepEqual([...routes.keys()].sort(), [
    '/admin/stats',
    '/api/users',
    '/api/users/:id',
    '/health',
    '/v1/items',
    '/v1/items/:id',
  ]);
  assert.deepEqual(routes.get('/api/users')?.methods, ['GET', 'POST']);
  assert.deepEqual(routes.get('/api/users/:id')?.methods, ['PUT', 'PATCH']);
  assert.equal(routes.get('/health')?.router, 'fastify');
});

test('reads JSON Schema bodies and querystrings from route options', async () => {
  const routes = await byPath();
  const users = routes.get('/api/users')?.methodsMetadata;

  assert.deepEqual(users?.GET?.query, ['page']);
  assert.deepEqual(JSON.parse(users!.POST!.body!), { email: 'user@example.com', age: 10 });
  assert.deepEqual(users?.POST?.bodySchema?.required, ['email']);
});

test('detects authentication from route hooks, scoped addHook and header reads', async () => {
  const routes = await byPath();

  assert.deepEqual(routes.get('/api/users/:id')?.methodsMetadata?.PATCH?.headers, ['Authorization']);
  assert.deepEqual(routes.get('/admin/stats')?.methodsMetadata?.GET, { headers: ['Authorization'], query: ['range'] });
  assert.deepEqual(routes.get('/v1/items/:id')?.methodsMetadata?.DELETE?.headers, ['Authorization']);
  assert.equal(routes.get('/health')?.methodsMetadata, undefined);
});

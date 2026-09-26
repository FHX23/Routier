import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanExpressRoutes } from '../src/parsers/express/index.js';

const fixture = path.resolve('tests/fixtures/express-app');

async function byPath() {
  const { endpoints } = await scanExpressRoutes({ cwd: fixture });
  return new Map(endpoints.map((endpoint) => [endpoint.path, endpoint]));
}

test('resolves mount prefixes across ESM, named and CommonJS router modules', async () => {
  const routes = await byPath();

  assert.deepEqual([...routes.keys()].sort(), [
    '/api/legacy/items',
    '/api/posts',
    '/api/posts/:id',
    '/api/users',
    '/api/users/:id',
    '/graphql',
    '/health',
  ]);
  assert.deepEqual(routes.get('/api/users')?.methods, ['GET', 'POST']);
  assert.deepEqual(routes.get('/api/users/:id')?.methods, ['GET', 'DELETE']);
  assert.equal(routes.get('/api/users')?.router, 'express');
  assert.equal(routes.get('/graphql')?.fileType, 'graphql');
});

test('ignores setting getters and client-side HTTP calls', async () => {
  const routes = await byPath();
  assert.equal(routes.has('env'), false);
  assert.equal([...routes.values()].some((endpoint) => endpoint.sourceFile.includes('client')), false);
});

test('infers auth from middlewares, headers, query params and Zod bodies from validators or handlers', async () => {
  const routes = await byPath();

  assert.deepEqual(routes.get('/api/users/:id')?.methodsMetadata?.DELETE?.headers, ['Authorization']);
  assert.equal(routes.get('/api/users/:id')?.methodsMetadata?.GET, undefined);
  assert.deepEqual(routes.get('/api/posts')?.methodsMetadata?.GET?.headers, ['Authorization', 'X-Api-Key']);
  assert.deepEqual(routes.get('/api/users')?.methodsMetadata?.GET?.query, ['page', 'limit']);

  const createBody = JSON.parse(routes.get('/api/users')!.methodsMetadata!.POST!.body!);
  assert.deepEqual(createBody, { email: 'user@example.com', name: 'string', admin: false });

  const patchBody = JSON.parse(routes.get('/api/posts/:id')!.methodsMetadata!.PATCH!.body!);
  assert.deepEqual(patchBody, { title: 'string', published: true });
});

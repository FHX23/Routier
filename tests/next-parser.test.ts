import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanNextRoutes } from '../src/parsers/next/index.js';

const fixture = path.resolve('fixtures/next-app');

test('scanNextRoutes detects app and pages router endpoints', async () => {
  const routes = await scanNextRoutes({ cwd: fixture });
  const byPath = new Map(routes.map((route) => [route.path, route]));

  assert.equal(byPath.get('/api/graphql')?.fileType, 'graphql');
  assert.deepEqual(byPath.get('/api/graphql')?.methods, ['POST']);
  assert.deepEqual(byPath.get('/api/users/:id')?.methods, ['GET', 'DELETE']);
  assert.deepEqual(byPath.get('/api/files/:slug')?.methods, ['POST']);
  assert.deepEqual(byPath.get('/api/docs/:path')?.methods, ['GET']);
  assert.deepEqual(byPath.get('/api/comments')?.methods, ['GET', 'POST']);
  assert.deepEqual(byPath.get('/api/legacy/:id')?.methods, ['GET', 'POST']);
  assert.equal(byPath.get('/api/legacy/:id')?.router, 'pages');
});

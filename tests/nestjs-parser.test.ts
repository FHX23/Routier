import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanNestRoutes } from '../src/parsers/nestjs/index.js';

const fixture = path.resolve('tests/fixtures/nest-app');

async function byPath() {
  const { endpoints } = await scanNestRoutes({ cwd: fixture });
  return new Map(endpoints.map((endpoint) => [endpoint.path, endpoint]));
}

test('combines global prefix, URI versioning, controller and method paths', async () => {
  const routes = await byPath();

  assert.deepEqual([...routes.keys()].sort(), [
    '/api/health',
    '/api/v1/auth/login',
    '/api/v1/users',
    '/api/v1/users/:id',
    '/api/v2/users/:id',
  ]);
  assert.deepEqual(routes.get('/api/v1/users')?.methods, ['GET', 'POST']);
  assert.deepEqual(routes.get('/api/v1/users/:id')?.methods, ['GET', 'DELETE']);
  assert.deepEqual(routes.get('/api/v2/users/:id')?.methods, ['PATCH']);
  assert.equal(routes.get('/api/health')?.router, 'nestjs');
});

test('applies class guards unless the method is @Public()', async () => {
  const routes = await byPath();
  const users = routes.get('/api/v1/users')?.methodsMetadata;

  assert.equal(users?.GET?.headers, undefined);
  assert.deepEqual(users?.POST?.headers, ['Authorization', 'x-request-id']);
  assert.deepEqual(routes.get('/api/v1/users/:id')?.methodsMetadata?.DELETE?.headers, ['Authorization']);
});

test('reads @Query() params and class-validator DTOs, including nested DTOs and PartialType', async () => {
  const routes = await byPath();

  assert.deepEqual(routes.get('/api/v1/users')?.methodsMetadata?.GET?.query, ['page', 'search', 'sort']);

  const create = routes.get('/api/v1/users')!.methodsMetadata!.POST!;
  assert.deepEqual(JSON.parse(create.body!), {
    email: 'user@example.com',
    name: 'string',
    age: 10,
    role: 'admin',
    address: { city: 'string' },
    tags: ['string'],
  });
  assert.deepEqual(create.bodySchema?.required, ['email', 'name', 'role', 'address', 'tags']);

  const update = routes.get('/api/v2/users/:id')!.methodsMetadata!.PATCH!;
  assert.equal(update.bodySchema?.required, undefined);
});

test('uses Zod schemas passed to ZodValidationPipe', async () => {
  const routes = await byPath();
  const login = routes.get('/api/v1/auth/login')!.methodsMetadata!.POST!;
  assert.deepEqual(JSON.parse(login.body!), { email: 'user@example.com', password: 'string' });
});

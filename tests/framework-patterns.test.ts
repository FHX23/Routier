import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanProject } from '../src/scanner.js';
import type { Endpoint, HttpMethod } from '../src/types.js';

async function scan(name: string) {
  const result = await scanProject({ cwd: path.resolve('tests/fixtures', name) });
  return new Map<string, Endpoint>(result.endpoints.map((endpoint) => [endpoint.path, endpoint]));
}

const meta = (routes: Map<string, Endpoint>, route: string, method: HttpMethod) => routes.get(route)?.methodsMetadata?.[method];
const props = (routes: Map<string, Endpoint>, route: string, method: HttpMethod) =>
  Object.keys(meta(routes, route, method)?.bodySchema?.properties ?? {}).sort();

test('Express: forEach mounts, anonymous chained routers and ignored preflight', async () => {
  const routes = await scan('express-patterns');
  assert.deepEqual([...routes.keys()].sort(), [
    '/v1/articles',
    '/v1/auth/avatar',
    '/v1/auth/register',
    '/v1/auth/reset-password',
  ]);
  assert.deepEqual(routes.get('/v1/articles')?.methods, ['GET', 'POST']);
});

test('Express: setup middlewares are not auth; optional vs required auth', async () => {
  const routes = await scan('express-patterns');
  assert.equal(meta(routes, '/v1/auth/register', 'POST')?.auth, undefined);
  assert.deepEqual(meta(routes, '/v1/articles', 'GET')?.auth, { type: 'bearer', optional: true });
  assert.deepEqual(meta(routes, '/v1/articles', 'POST')?.auth, { type: 'bearer' });
  assert.deepEqual(meta(routes, '/v1/auth/avatar', 'POST')?.auth, { type: 'bearer' });
});

test('Express: Joi validators, multer uploads and values followed into services', async () => {
  const routes = await scan('express-patterns');
  const register = meta(routes, '/v1/auth/register', 'POST')!;
  assert.deepEqual(props(routes, '/v1/auth/register', 'POST'), ['email', 'name', 'password', 'role']);
  assert.deepEqual(register.bodySchema?.required, ['email', 'password', 'name']);
  assert.equal(JSON.parse(register.body!).password.length >= 8, true);

  assert.deepEqual(meta(routes, '/v1/auth/reset-password', 'POST')?.query, ['token']);

  const avatar = meta(routes, '/v1/auth/avatar', 'POST')!;
  assert.equal(avatar.bodyContentType, 'multipart/form-data');
  assert.equal(avatar.bodySchema?.properties?.avatar.format, 'binary');
  assert.ok(avatar.bodySchema?.properties?.caption);

  assert.deepEqual(meta(routes, '/v1/articles', 'GET')?.query?.sort(), ['author', 'limit', 'tag']);
  const article = meta(routes, '/v1/articles', 'POST')?.bodySchema?.properties?.article;
  assert.deepEqual(Object.keys(article?.properties ?? {}).sort(), ['description', 'tagList', 'title']);
});

test('Fastify: autohooks sessions with exemptions, TypeBox bodies/querystrings and multipart', async () => {
  const routes = await scan('fastify-patterns');
  assert.equal(meta(routes, '/api/auth/login', 'POST')?.auth, undefined);
  assert.deepEqual(meta(routes, '/api/tasks', 'GET')?.auth, { type: 'session', cookie: 'sessionId' });

  assert.deepEqual(props(routes, '/api/auth/login', 'POST'), ['email', 'password']);
  assert.equal(JSON.parse(meta(routes, '/api/auth/login', 'POST')!.body!).email, 'user@example.com');

  const create = meta(routes, '/api/tasks', 'POST')!;
  assert.deepEqual(create.bodySchema?.required, ['name', 'status']);
  assert.deepEqual(create.bodySchema?.properties?.status.enum, ['new', 'done']);
  assert.deepEqual(meta(routes, '/api/tasks', 'GET')?.query, ['page', 'status']);

  assert.equal(meta(routes, '/api/tasks/:id/upload', 'POST')?.bodyContentType, 'multipart/form-data');
});

test('NestJS: config-based global prefix with exclude, forRoutes auth and services', async () => {
  const routes = await scan('nest-patterns');
  assert.deepEqual([...routes.keys()].sort(), ['/', '/api/articles', '/api/articles/:slug', '/api/articles/:slug/cover']);

  assert.equal(meta(routes, '/api/articles', 'GET')?.auth, undefined);
  assert.deepEqual(meta(routes, '/api/articles', 'POST')?.auth, { type: 'bearer' });
  assert.deepEqual(meta(routes, '/api/articles/:slug', 'DELETE')?.auth, { type: 'bearer' });

  assert.deepEqual(meta(routes, '/api/articles', 'GET')?.query?.sort(), ['limit', 'tag']);
  const article = meta(routes, '/api/articles', 'POST')?.bodySchema?.properties?.article;
  assert.deepEqual(Object.keys(article?.properties ?? {}).sort(), ['body', 'title']);

  const cover = meta(routes, '/api/articles/:slug/cover', 'POST')!;
  assert.equal(cover.bodyContentType, 'multipart/form-data');
  assert.deepEqual(Object.keys(cover.bodySchema?.properties ?? {}).sort(), ['caption', 'cover']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanProject } from '../src/scanner.js';
import { generateOpenAPI } from '../src/generators/openapi.js';
import { generatePostmanCollection } from '../src/exporters/postman.js';
import type { Endpoint, HttpMethod } from '../src/types.js';

async function scan(name: string) {
  const result = await scanProject({ cwd: path.resolve('tests/fixtures', name) });
  return new Map<string, Endpoint>(result.endpoints.map((endpoint) => [endpoint.path, endpoint]));
}

/** Query de cada request de la colección de Postman generada para un fixture. */
async function postmanQueries(name: string) {
  const result = await scanProject({ cwd: path.resolve('tests/fixtures', name) });
  const collection: any = generatePostmanCollection(generateOpenAPI(result, { baseUrl: '{{baseUrl}}' }), {});
  const flatten = (items: any[]): any[] => items.flatMap((item) => (item.item ? flatten(item.item) : [item]));
  return new Map<string, any[]>(flatten(collection.item).map((item) => [item.name, item.request.url.query ?? []]));
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
  assert.equal(register.bodySchema?.['x-validated'], true); // Joi.object().keys() sigue siendo un schema validado
  assert.equal(JSON.parse(register.body!).password.length >= 8, true);

  assert.deepEqual(meta(routes, '/v1/auth/reset-password', 'POST')?.query, ['token']);

  const avatar = meta(routes, '/v1/auth/avatar', 'POST')!;
  assert.equal(avatar.bodyContentType, 'multipart/form-data');
  assert.equal(avatar.bodySchema?.properties?.avatar.format, 'binary');
  assert.ok(avatar.bodySchema?.properties?.caption);

  assert.deepEqual(meta(routes, '/v1/articles', 'GET')?.query?.sort(), ['author', 'limit', 'tag']);
  const article = meta(routes, '/v1/articles', 'POST')?.bodySchema?.properties?.article;
  assert.deepEqual(Object.keys(article?.properties ?? {}).sort(), ['description', 'language', 'tagList', 'title', 'visibility']);
  assert.deepEqual(article?.properties?.visibility.enum, ['public', 'unlisted']); // `x in OBJ`
  assert.deepEqual(article?.properties?.language.enum, ['en', 'es']); // `Object.keys(OBJ).includes(x)`
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
  assert.deepEqual([...routes.keys()].sort(), ['/', '/api/articles', '/api/articles/:slug', '/api/articles/:slug/cover', '/api/articles/search']);

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

test('required query params from validators are documented and enabled with an example value', async () => {
  // Express + Joi: `query: Joi.object({ token: Joi.string().required() })`
  const express = await postmanQueries('express-patterns');
  assert.deepEqual(express.get('POST /v1/auth/reset-password'), [{ key: 'token', value: 'string' }]);

  // Fastify + TypeBox: `page` es obligatorio (con mínimo 1), `status` es opcional.
  const fastify = await postmanQueries('fastify-patterns');
  assert.deepEqual(fastify.get('GET /api/tasks'), [{ key: 'page', value: '1' }, { key: 'status', value: '', disabled: true }]);

  // NestJS + class-validator: `@IsOptional()` marca lo opcional.
  const routes = await scan('nest-patterns');
  const search = meta(routes, '/api/articles/search', 'GET')!;
  assert.deepEqual(search.query, ['term', 'page']);
  assert.deepEqual(search.querySchema?.required, ['term']);
  assert.equal(search.querySchema?.properties?.page.minimum, 1); // @Min(1)
  const nest = await postmanQueries('nest-patterns');
  assert.deepEqual(nest.get('GET /api/articles/search'), [{ key: 'term', value: 'string' }, { key: 'page', value: '1', disabled: true }]);

  const openapi: any = generateOpenAPI(await scanProject({ cwd: path.resolve('tests/fixtures/express-patterns') }), { baseUrl: '{{baseUrl}}' });
  assert.deepEqual(openapi.paths['/v1/auth/reset-password'].post.parameters, [
    { name: 'token', in: 'query', required: true, schema: { type: 'string' }, example: 'string' },
  ]);
});

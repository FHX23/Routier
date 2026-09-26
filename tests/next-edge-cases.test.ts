import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanNextRoutes } from '../src/parsers/next/index.js';
import { stripComments, findFunctionBody } from '../src/parsers/shared/code.js';

const edge = path.resolve('tests/fixtures/next-edge');
const monorepo = path.resolve('tests/fixtures/monorepo');

async function routesByPath(cwd: string) {
  const routes = await scanNextRoutes({ cwd });
  return new Map(routes.map((route) => [route.path, route]));
}

test('handlers with a destructured context param are analysed (not `{ params }`)', async () => {
  const byPath = await routesByPath(edge);
  const patch = byPath.get('/api/posts/:id')?.methodsMetadata?.PATCH;

  assert.deepEqual(patch?.headers, ['Authorization']);
  assert.ok(patch?.body, 'PATCH body should be inferred');
});

test('Zod schemas imported through the @/ alias are resolved with Zod 4 helpers and modifiers', async () => {
  const byPath = await routesByPath(edge);
  const patch = byPath.get('/api/posts/:id')?.methodsMetadata?.PATCH;
  const body = JSON.parse(patch!.body!);

  assert.deepEqual(body, {
    title: 'string',
    tags: [{ name: 'string' }],
    email: 'user@example.com',
    status: 'draft',
    rating: 10,
    author: { id: '123e4567-e89b-12d3-a456-426614174000' },
    website: 'https://example.com',
  });

  const schema = patch!.bodySchema!;
  assert.equal(schema.properties?.tags.type, 'array');
  assert.equal(schema.properties?.tags.items?.type, 'object');
  assert.equal(schema.properties?.rating.type, 'integer');
  assert.equal(schema.properties?.website.nullable, true);
  assert.deepEqual(schema.required?.sort(), ['author', 'email', 'tags', 'title', 'website']);
});

test('headers are scoped per method and GET never receives a body', async () => {
  const byPath = await routesByPath(edge);
  const post = byPath.get('/api/posts/:id');

  assert.equal(post?.methodsMetadata?.GET?.headers, undefined);
  assert.deepEqual(post?.methodsMetadata?.GET?.query, ['include']);

  const search = byPath.get('/api/search')?.methodsMetadata?.GET;
  assert.equal(search?.body, undefined);
  assert.deepEqual(search?.query, ['q']);
});

test('wrapped handlers, export aliases and destructured exports are detected', async () => {
  const byPath = await routesByPath(edge);

  const reports = byPath.get('/api/reports');
  assert.deepEqual(reports?.methods, ['POST', 'DELETE']);
  assert.deepEqual(reports?.methodsMetadata?.DELETE?.headers, ['Authorization']);
  assert.deepEqual(reports?.methodsMetadata?.POST?.headers, ['X-Api-Key']);

  assert.deepEqual(byPath.get('/api/auth/:nextauth')?.methods, ['GET', 'POST']);
});

test('private folders are not exposed as routes', async () => {
  const byPath = await routesByPath(edge);
  assert.equal([...byPath.keys()].some((route) => route.includes('secret')), false);
});

test('routes inside monorepo workspaces keep their real path', async () => {
  const byPath = await routesByPath(monorepo);
  assert.deepEqual([...byPath.keys()].sort(), ['/api/health', '/api/ping']);
});

test('stripComments keeps URLs and comment-like text inside strings', () => {
  const code = "const a = 'http://x.dev/{id}'; // comment\nconst b = `/* not a comment */`; /* block */";
  const stripped = stripComments(code);

  assert.ok(stripped.includes("'http://x.dev/{id}'"));
  assert.ok(stripped.includes('`/* not a comment */`'));
  assert.equal(stripped.includes('comment\n'), false);
  assert.equal(stripped.includes('block'), false);
  assert.equal(stripped.length, code.length);
});

test('findFunctionBody skips parameter lists and return types', () => {
  const code = 'export async function GET(req: Request, { params }: Ctx): Promise<{ ok: boolean }> { return run(params); }';
  assert.equal(findFunctionBody(code, 'GET'), '{ return run(params); }');

  const arrow = 'export const POST = async ({ body }) => json(body);';
  assert.equal(findFunctionBody(arrow, 'POST')?.trim(), 'json(body)');
});

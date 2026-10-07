import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanProject } from '../src/scanner.js';
import { generateOpenAPI } from '../src/generators/openapi.js';
import type { Endpoint } from '../src/types.js';

const fixture = path.resolve('tests/fixtures/next-patterns');

async function scan() {
  const result = await scanProject({ cwd: fixture });
  const byPath = new Map<string, Endpoint>(result.endpoints.map((endpoint) => [endpoint.path, endpoint]));
  return { result, byPath };
}

const fields = (endpoint: Endpoint | undefined, method: 'POST' | 'PUT' | 'PATCH') =>
  Object.keys(endpoint?.methodsMetadata?.[method]?.bodySchema?.properties ?? {}).sort();

test('follows the body into imported server actions typed with z.infer', async () => {
  const { byPath } = await scan();
  const post = byPath.get('/api/products')?.methodsMetadata?.POST;
  assert.deepEqual(fields(byPath.get('/api/products'), 'POST'), ['price', 'stock', 'title']);
  assert.equal(JSON.parse(post!.body!).price, 100);
});

test('uses TypeScript types: utility types in other files, inline `as` literals and `let x: T; x = ...`', async () => {
  const { byPath } = await scan();
  assert.deepEqual(fields(byPath.get('/api/profile'), 'PUT'), ['firstName', 'lastName', 'newsletter']);
  assert.deepEqual(fields(byPath.get('/api/profile'), 'PATCH'), ['avatarUrl', 'nickname']);
  assert.deepEqual(fields(byPath.get('/api/login'), 'POST'), ['email', 'password']);
});

test('reads destructured bodies with defaults', async () => {
  const { byPath } = await scan();
  const checkout = byPath.get('/api/checkout')!;
  assert.deepEqual(fields(checkout, 'POST'), ['amount', 'currency', 'email', 'interval', 'isRecurring', 'plan']);
  assert.equal(JSON.parse(checkout.methodsMetadata!.POST!.body!).isRecurring, false);
});

test('allow-lists checked in the handler become enums (local, imported, Set and inline lists)', async () => {
  const { byPath } = await scan();
  const post = byPath.get('/api/checkout')!.methodsMetadata!.POST!;
  const properties = post.bodySchema!.properties!;
  assert.deepEqual(properties.currency.enum, ['CLP', 'USD']);
  assert.deepEqual(properties.plan.enum, ['basic', 'professional']);
  assert.deepEqual(properties.interval.enum, ['month', 'year']);
  assert.equal(properties.email.enum, undefined);
  assert.equal(JSON.parse(post.body!).plan, 'basic');
});

test('only Zod validations applied to the body define it (not params validation)', async () => {
  const { byPath } = await scan();
  assert.deepEqual(fields(byPath.get('/api/posts/:postId'), 'PATCH'), ['content', 'title']);
});

test('documents multipart uploads through actions and text bodies', async () => {
  const { byPath } = await scan();
  const upload = byPath.get('/api/upload')!.methodsMetadata!.POST!;
  assert.equal(upload.bodyContentType, 'multipart/form-data');
  assert.equal(upload.bodySchema?.properties?.file.format, 'binary');
  assert.equal(upload.bodySchema?.properties?.folder.type, 'string');

  const webhook = byPath.get('/api/webhooks/stripe')!.methodsMetadata!.POST!;
  assert.equal(webhook.bodyContentType, 'text/plain');
  assert.deepEqual(webhook.headers, ['Stripe-Signature']);
});

test('detects next-auth sessions directly, through helpers (even mutually recursive) and via middleware', async () => {
  const { byPath } = await scan();
  const session = { type: 'session', cookie: 'authjs.session-token' };
  assert.deepEqual(byPath.get('/api/profile')?.methodsMetadata?.PUT?.auth, session); // helper importado
  assert.deepEqual(byPath.get('/api/posts/:postId')?.methodsMetadata?.PATCH?.auth, session); // helper local
  assert.deepEqual(byPath.get('/api/products')?.methodsMetadata?.POST?.auth, session); // middleware
  assert.equal(byPath.get('/api/public/health')?.methodsMetadata?.GET?.auth, undefined); // excepción del middleware
  assert.equal(byPath.get('/api/login')?.methodsMetadata?.POST?.auth, undefined);
});

test('GraphQL endpoints keep GET/POST, inherit the session and document it in OpenAPI', async () => {
  const { result, byPath } = await scan();
  const graphql = byPath.get('/api/graphql')!;
  assert.deepEqual(graphql.methods.sort(), ['GET', 'POST']);

  const doc = generateOpenAPI(result, { baseUrl: 'http://localhost:3000' });
  assert.deepEqual(doc.components?.securitySchemes?.sessionAuth, { type: 'apiKey', in: 'cookie', name: 'authjs.session-token' });
  assert.deepEqual(doc.paths['/api/graphql'].post.security, [{ sessionAuth: [] }]);
  assert.ok(doc.paths['/api/graphql'].get);
  assert.equal(doc.paths['/api/upload'].post.requestBody.content['multipart/form-data'].schema.properties.file.format, 'binary');
});

test('GraphQL variables for custom scalars use realistic values', async () => {
  const { result } = await scan();
  const now = result.graphqlOperations.find((operation) => operation.name === 'now');
  assert.deepEqual(now?.variables, { after: '2024-01-01T00:00:00.000Z' });
});

test('resolves Prisma 7 const enums through re-exports and field casts to literal unions', async () => {
  const { byPath } = await scan();
  const seller = byPath.get('/api/sellers/:id')?.methodsMetadata?.PATCH;
  assert.deepEqual(seller?.bodySchema?.properties?.status.enum, ['PENDING_APPROVAL', 'ACTIVE']);
  assert.equal(JSON.parse(seller!.body!).status, 'PENDING_APPROVAL');

  const login = byPath.get('/api/dev-login')?.methodsMetadata?.POST;
  assert.deepEqual(JSON.parse(login!.body!), { role: 'ADMIN' });
});

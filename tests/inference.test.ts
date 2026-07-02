import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanNextRoutes } from '../src/parsers/next/index.js';
import { generateOpenAPI, parseOpenAPI } from '../src/generators/openapi.js';
import { generatePostmanCollection } from '../src/exporters/postman.js';
import { generateInsomniaExport } from '../src/exporters/insomnia.js';

const fixture = path.resolve('fixtures/next-app');

test('scanNextRoutes infers headers and request bodies from Zod schemas', async () => {
  const routes = await scanNextRoutes({ cwd: fixture });
  const byPath = new Map(routes.map((route) => [route.path, route]));

  // 1. App Router validation
  const usersRoute = byPath.get('/api/users');
  assert.equal(usersRoute !== undefined, true);
  assert.equal(usersRoute?.router, 'app');
  assert.equal(usersRoute?.methodsMetadata !== undefined, true);

  const postMeta = usersRoute?.methodsMetadata?.['POST'];
  assert.deepEqual(postMeta?.headers?.sort(), ['Authorization', 'X-Custom-Header'].sort());
  assert.equal(postMeta?.body !== undefined, true);

  const postBody = JSON.parse(postMeta!.body!);
  assert.equal(postBody.name, 'string');
  assert.equal(postBody.email, 'user@example.com');
  assert.equal(postBody.role, 'admin');
  assert.deepEqual(postBody.meta, { age: 10 });

  const getMeta = usersRoute?.methodsMetadata?.['GET'];
  assert.deepEqual(getMeta?.headers, ['Authorization']);
  assert.equal(getMeta?.body, undefined);

  // 2. Pages Router validation
  const specificRoute = byPath.get('/api/specific');
  assert.equal(specificRoute !== undefined, true);
  assert.equal(specificRoute?.router, 'pages');
  assert.equal(specificRoute?.methodsMetadata !== undefined, true);

  const patchMeta = specificRoute?.methodsMetadata?.['PATCH'];
  assert.deepEqual(patchMeta?.headers, ['Authorization']);
  assert.equal(patchMeta?.body !== undefined, true);

  const patchBody = JSON.parse(patchMeta!.body!);
  assert.equal(patchBody.id, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(patchBody.active, true);

  const deleteMeta = specificRoute?.methodsMetadata?.['DELETE'];
  assert.deepEqual(deleteMeta?.headers, ['Authorization']);
  assert.equal(deleteMeta?.body, undefined);
});

test('generateOpenAPI and parseOpenAPI preserve advanced inference roundtrip lossless', async () => {
  const routes = await scanNextRoutes({ cwd: fixture });
  const openapi = generateOpenAPI(
    { endpoints: routes, graphqlOperations: [], warnings: [] },
    { baseUrl: 'http://localhost:3000' }
  );

  // Validar esquema OpenAPI
  const usersPath = openapi.paths['/api/users'];
  assert.equal(usersPath !== undefined, true);
  
  const postOp = usersPath.post;
  assert.equal(postOp !== undefined, true);
  assert.equal(postOp.parameters !== undefined, true);
  assert.equal(postOp.parameters.some((p: any) => p.name === 'X-Custom-Header' && p.in === 'header'), true);
  assert.equal(postOp.requestBody !== undefined, true);
  assert.equal(postOp.requestBody.content['application/json'].schema.example.email, 'user@example.com');

  // Validar ingeniería inversa
  const restored = parseOpenAPI(openapi);
  const usersRestored = restored.endpoints.find((e) => e.path === '/api/users');
  assert.equal(usersRestored?.methodsMetadata !== undefined, true);
  assert.deepEqual(usersRestored?.methodsMetadata?.['POST']?.headers?.sort(), ['Authorization', 'X-Custom-Header'].sort());
  assert.equal(usersRestored?.methodsMetadata?.['POST']?.body !== undefined, true);
});

test('exporters inject headers and payloads into Postman and Insomnia collections', async () => {
  const routes = await scanNextRoutes({ cwd: fixture });
  const openapi = generateOpenAPI(
    { endpoints: routes, graphqlOperations: [], warnings: [] },
    { baseUrl: 'http://localhost:3000' }
  );

  // Postman Collection
  const postman = generatePostmanCollection(openapi, { baseUrl: 'http://localhost:3000' });
  const restFolder = postman.item.find((f) => f.name === 'REST');
  const postFolder = restFolder?.item?.find((f) => f.name === 'POST');
  const usersItem = postFolder?.item?.find((req) => req.name === 'POST /api/users') as any;

  assert.equal(usersItem !== undefined, true);
  assert.equal(usersItem.request?.header.some((h: any) => h.key === 'X-Custom-Header'), true);
  assert.equal(usersItem.request?.body?.raw?.includes('user@example.com'), true);

  // Insomnia Export
  const insomnia = generateInsomniaExport(openapi, { baseUrl: 'http://localhost:3000' });
  const usersReq = (insomnia.resources as any[]).find(
    (r) => r._type === 'request' && r.name === 'POST /api/users'
  );

  assert.equal(usersReq !== undefined, true);
  assert.equal(usersReq.headers.some((h: any) => h.name === 'X-Custom-Header'), true);
  assert.equal(usersReq.body?.text?.includes('user@example.com'), true);
});

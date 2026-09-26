import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateOpenAPI, parseOpenAPI } from '../src/generators/openapi.js';
import type { ScanResult } from '../src/types.js';

const scan: ScanResult = {
  endpoints: [
    {
      path: '/api/users/:id',
      methods: ['GET', 'POST'],
      fileType: 'rest',
      sourceFile: 'app/api/users/[id]/route.ts',
      router: 'app',
    },
    {
      path: '/api/files/:slug',
      methods: ['DELETE'],
      fileType: 'rest',
      sourceFile: 'app/api/files/[slug]/route.ts',
      router: 'app',
    },
    {
      path: '/api/graphql',
      methods: ['POST'],
      fileType: 'graphql',
      sourceFile: 'app/api/graphql/route.ts',
      router: 'app',
    },
  ],
  graphqlOperations: [
    {
      type: 'query',
      name: 'health',
      arguments: [],
      variables: {},
      body: {
        query: 'query health { health }',
        variables: {},
      },
      sourceFile: 'schema.graphql',
    },
  ],
  warnings: [],
};

test('generateOpenAPI converts path parameters and adds parameters specs', () => {
  const openapi = generateOpenAPI(scan, { baseUrl: 'http://localhost:3000' });

  // Convertir `:id` -> `{id}` en las llaves del path
  assert.equal(openapi.paths['/api/users/{id}'] !== undefined, true);
  assert.equal(openapi.paths['/api/files/{slug}'] !== undefined, true);

  // Mapear parámetros en la especificación
  const userParams = openapi.paths['/api/users/{id}'].parameters;
  assert.equal(userParams.length, 1);
  assert.equal(userParams[0].name, 'id');
  assert.equal(userParams[0].in, 'path');
  assert.equal(userParams[0].required, true);
});

test('generateOpenAPI documents GraphQL operations as examples of the real endpoint', () => {
  const openapi = generateOpenAPI(scan, { baseUrl: 'http://localhost:3000' });
  const graphql = openapi.paths['/api/graphql'];
  const media = graphql.post.requestBody.content['application/json'];

  assert.equal(graphql['x-routier-graphql-endpoint'], true);
  assert.deepEqual(media.examples.query_health.value, { query: 'query health { health }', variables: {} });
  assert.equal(graphql.post['x-routier-graphql-operations'][0].name, 'health');
  assert.equal(Object.keys(openapi.paths).some((key) => key.startsWith('/api/graphql/')), false);
});

test('generateOpenAPI adds unique operationIds, resource tags and document metadata', () => {
  const openapi = generateOpenAPI(scan, { baseUrl: 'http://localhost:3000', title: 'Demo API', version: '2.0.0' });

  assert.equal(openapi.info.title, 'Demo API');
  assert.equal(openapi.info.version, '2.0.0');
  assert.equal(openapi.paths['/api/users/{id}'].get.operationId, 'getApiUsersById');
  assert.equal(openapi.paths['/api/users/{id}'].post.operationId, 'postApiUsersById');
  assert.deepEqual(openapi.paths['/api/users/{id}'].get.tags, ['users']);
  assert.deepEqual(openapi.tags.map((tag: any) => tag.name), ['GraphQL', 'files', 'users']);
});

test('GraphQL requests use the detected endpoint path', () => {
  const custom: ScanResult = {
    ...scan,
    endpoints: scan.endpoints.map((endpoint) => endpoint.fileType === 'graphql' ? { ...endpoint, path: '/graphql' } : endpoint),
  };
  const openapi = generateOpenAPI(custom, { baseUrl: 'http://localhost:3000' });
  const restored = parseOpenAPI(openapi);

  assert.ok(openapi.paths['/graphql']);
  assert.equal(openapi.paths['/api/graphql'], undefined);
  assert.equal(restored.endpoints.find((endpoint) => endpoint.fileType === 'graphql')?.path, '/graphql');
});

test('parseOpenAPI performs engineering roundtrip to restore standard ScanResult', () => {
  const openapi = generateOpenAPI(scan, { baseUrl: 'http://localhost:3000' });
  const restored = parseOpenAPI(openapi);

  // Validar endpoints REST restablecidos
  const userEndpoint = restored.endpoints.find((e) => e.path === '/api/users/:id');
  assert.equal(userEndpoint !== undefined, true);
  assert.equal(userEndpoint?.fileType, 'rest');
  assert.deepEqual(userEndpoint?.methods.sort(), ['GET', 'POST']);

  const fileEndpoint = restored.endpoints.find((e) => e.path === '/api/files/:slug');
  assert.equal(fileEndpoint !== undefined, true);
  assert.equal(fileEndpoint?.fileType, 'rest');
  assert.deepEqual(fileEndpoint?.methods, ['DELETE']);

  // Validar GraphQL endpoint restablecido
  const gqlEndpoint = restored.endpoints.find((e) => e.path === '/api/graphql');
  assert.equal(gqlEndpoint !== undefined, true);
  assert.equal(gqlEndpoint?.fileType, 'graphql');

  // Validar operaciones GraphQL restablecidas
  const healthOp = restored.graphqlOperations.find((op) => op.name === 'health');
  assert.equal(healthOp !== undefined, true);
  assert.equal(healthOp?.type, 'query');
  assert.equal(healthOp?.body.query, 'query health { health }');
});

test('generateOpenAPI exports strict variables when baseUrl is variable template', () => {
  const openapi = generateOpenAPI(scan, { baseUrl: '{{baseUrl}}' });
  
  assert.equal(openapi.servers[0].url, '{baseUrl}');
  assert.equal(openapi.servers[0].variables?.baseUrl.default, 'http://localhost:3000');
});

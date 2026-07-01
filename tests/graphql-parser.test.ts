import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanGraphQLSchema } from '../src/parsers/graphql/index.js';

test('scanGraphQLSchema extracts Query and Mutation operations using hybrid scanning and AST selection rules', async () => {
  const result = await scanGraphQLSchema({ cwd: path.resolve('fixtures/next-app') });
  const names = result.operations.map((operation) => `${operation.type}:${operation.name}`).sort();

  // Debería incluir tanto operaciones de schema.graphql como de api/graphql/route.ts
  assert.deepEqual(names, [
    'mutation:createUser',
    'query:currentTime',
    'query:getPost',
    'query:health',
    'query:info',
    'query:user'
  ]);

  const userOp = result.operations.find((op) => op.name === 'user');
  const getPostOp = result.operations.find((op) => op.name === 'getPost');
  const currentTimeOp = result.operations.find((op) => op.name === 'currentTime');

  // Tipo objeto con campo ID -> selecciona { id }
  assert.equal(userOp?.body.query, 'query user($id: ID!) { user(id: $id) { id } }');

  // Tipo objeto sin ID -> selecciona el primer escalar disponible ({ title })
  assert.equal(getPostOp?.body.query, 'query getPost { getPost { title } }');

  // Tipo Custom Scalar (DateTime) -> sin bloque de selección
  assert.equal(currentTimeOp?.body.query, 'query currentTime { currentTime }');

  assert.deepEqual(result.warnings, []);
});

test('scanGraphQLSchema extracts static typeDefs from TypeScript files', async () => {
  const result = await scanGraphQLSchema({ cwd: path.resolve('fixtures/graphql-ts') });
  const names = result.operations.map((operation) => `${operation.type}:${operation.name}`).sort();

  assert.deepEqual(names, ['mutation:ping', 'query:status']);
});

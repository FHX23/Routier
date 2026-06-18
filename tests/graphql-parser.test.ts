import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanGraphQLSchema } from '../src/parsers/graphql/index.js';

test('scanGraphQLSchema extracts Query and Mutation operations from .graphql files', async () => {
  const result = await scanGraphQLSchema({ cwd: path.resolve('fixtures/next-app') });
  const names = result.operations.map((operation) => `${operation.type}:${operation.name}`).sort();

  assert.deepEqual(names, ['mutation:createUser', 'query:health', 'query:user']);
  assert.equal(result.operations.find((operation) => operation.name === 'user')?.variables.id, 'id');
  assert.deepEqual(result.warnings, []);
});

test('scanGraphQLSchema extracts static typeDefs from TypeScript files', async () => {
  const result = await scanGraphQLSchema({ cwd: path.resolve('fixtures/graphql-ts') });
  const names = result.operations.map((operation) => `${operation.type}:${operation.name}`).sort();

  assert.deepEqual(names, ['mutation:ping', 'query:status']);
});

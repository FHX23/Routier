import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateInsomniaExport } from '../src/exporters/insomnia.js';
import { generatePostmanCollection } from '../src/exporters/postman.js';
import { generateOpenAPI } from '../src/generators/openapi.js';
import type { ScanResult } from '../src/types.js';

const scan: ScanResult = {
  endpoints: [
    {
      path: '/api/users/:id',
      methods: ['GET'],
      fileType: 'rest',
      sourceFile: 'app/api/users/[id]/route.ts',
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
      name: 'user',
      arguments: [{ name: 'id', type: 'ID!', required: true }],
      variables: { id: 'id' },
      body: {
        query: 'query user($id: ID!) { user(id: $id) { id } }',
        variables: { id: 'id' },
      },
      sourceFile: 'schema.graphql',
    },
    {
      type: 'mutation',
      name: 'createUser',
      arguments: [{ name: 'name', type: 'String!', required: true }],
      variables: { name: 'string' },
      body: {
        query: 'mutation createUser($name: String!) { createUser(name: $name) { id } }',
        variables: { name: 'string' },
      },
      sourceFile: 'schema.graphql',
    },
  ],
  warnings: [],
};

const openapi = generateOpenAPI(scan, { baseUrl: 'http://localhost:3000' });

test('generatePostmanCollection groups REST and GraphQL by type by default', () => {
  const collection = generatePostmanCollection(openapi, { baseUrl: 'http://localhost:3000' });
  const restFolder = collection.item.find((item) => item.name === 'REST');
  const graphqlFolder = collection.item.find((item) => item.name === 'GraphQL');
  const queriesFolder = graphqlFolder?.item?.find((item) => item.name === 'Queries');
  const mutationsFolder = graphqlFolder?.item?.find((item) => item.name === 'Mutations');

  assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  assert.equal(restFolder?.item?.[0].name, 'GET');
  assert.equal(queriesFolder?.item?.[0].name, 'user');
  assert.equal(mutationsFolder?.item?.[0].name, 'createUser');
});

test('generatePostmanCollection supports flat output with groupBy none', () => {
  const collection = generatePostmanCollection(openapi, {
    baseUrl: 'http://localhost:3000',
    groupBy: 'none',
  });

  assert.equal(collection.item.length, 4);
  assert.equal(collection.item.some((item) => item.name === 'GraphQL'), false);
  assert.equal(collection.item.some((item) => item.name === 'createUser'), true);
});

test('generateInsomniaExport creates request groups by type by default', () => {
  const insomnia = generateInsomniaExport(openapi, { baseUrl: 'http://localhost:3000' });
  const folders = insomnia.resources.filter((resource) => resource._type === 'request_group');
  const requests = insomnia.resources.filter((resource) => resource._type === 'request');

  assert.equal(insomnia._type, 'export');
  assert.equal(folders.some((folder) => folder.name === 'REST'), true);
  assert.equal(folders.some((folder) => folder.name === 'Queries'), true);
  assert.equal(folders.some((folder) => folder.name === 'Mutations'), true);
  assert.equal(requests.some((request) => request.name === 'createUser'), true);
});

test('generateInsomniaExport supports flat output with groupBy none', () => {
  const insomnia = generateInsomniaExport(openapi, {
    baseUrl: 'http://localhost:3000',
    groupBy: 'none',
  });
  const folders = insomnia.resources.filter((resource) => resource._type === 'request_group');
  const requests = insomnia.resources.filter((resource) => resource._type === 'request');

  assert.equal(folders.length, 0);
  assert.equal(requests.length, 4);
});

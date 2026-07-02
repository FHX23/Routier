import type { GroupBy, SortMode } from './index.js';
import type { Endpoint, GraphQLOperation, HttpMethod, ScanResult } from '../types.js';
import { parseOpenAPI } from '../generators/openapi.js';

interface ExportOptions {
  name?: string;
  baseUrl: string;
  groupBy?: GroupBy;
  sort?: SortMode;
}

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: unknown;
}

interface RestRequest {
  endpoint: Endpoint;
  method: HttpMethod;
}

const METHOD_ORDER: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function generatePostmanCollection(openapi: any, options: ExportOptions) {
  const scan = parseOpenAPI(openapi);
  const name = options.name ?? 'Routier API';
  const groupBy = options.groupBy ?? 'type';
  const sort = options.sort ?? 'alpha';

  const rawBaseUrl = openapi.servers?.[0]?.url ?? options.baseUrl;
  const baseUrl = (rawBaseUrl === '{baseUrl}' || rawBaseUrl === '{{baseUrl}}')
    ? '{{baseUrl}}'
    : rawBaseUrl;

  return {
    info: {
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: buildItems(scan, { ...options, baseUrl, groupBy, sort }),
    variable: [{ key: 'baseUrl', value: baseUrl === '{{baseUrl}}' ? 'http://localhost:3000' : baseUrl }],
  };
}

function buildItems(scan: ScanResult, options: Required<Pick<ExportOptions, 'baseUrl' | 'groupBy' | 'sort'>>): PostmanItem[] {
  const restRequests = scan.endpoints
    .filter((endpoint) => endpoint.fileType !== 'graphql')
    .flatMap((endpoint) => endpoint.methods.map((method) => ({ endpoint, method })));
  const graphqlEndpointRequests = scan.endpoints
    .filter((endpoint) => endpoint.fileType === 'graphql')
    .flatMap((endpoint) => endpoint.methods.map((method) => ({ endpoint, method })));
  const graphqlOperations = sortGraphqlOperations(scan.graphqlOperations, options.sort);

  if (options.groupBy === 'none') {
    return [
      ...sortRestRequests([...restRequests, ...graphqlEndpointRequests], options.sort).map((request) => restToItem(request, options.baseUrl)),
      ...graphqlOperations.map((operation) => graphqlToItem(operation, options.baseUrl)),
    ];
  }

  if (options.groupBy === 'method') {
    return methodFolders([...restRequests, ...graphqlEndpointRequests], options);
  }

  if (options.groupBy === 'path') {
    return pathFolders([...restRequests, ...graphqlEndpointRequests], graphqlOperations, options);
  }

  return [
    {
      name: 'REST',
      item: methodFolders(restRequests, options),
    },
    {
      name: 'GraphQL',
      item: [
        {
          name: 'Queries',
          item: graphqlOperations
            .filter((operation) => operation.type === 'query')
            .map((operation) => graphqlToItem(operation, options.baseUrl)),
        },
        {
          name: 'Mutations',
          item: graphqlOperations
            .filter((operation) => operation.type === 'mutation')
            .map((operation) => graphqlToItem(operation, options.baseUrl)),
        },
        {
          name: 'Endpoint',
          item: sortRestRequests(graphqlEndpointRequests, options.sort)
            .map((request) => restToItem(request, options.baseUrl)),
        },
      ].filter((folder) => folder.item.length > 0),
    },
  ].filter((folder) => folder.item.length > 0);
}

function methodFolders(requests: RestRequest[], options: Required<Pick<ExportOptions, 'baseUrl' | 'sort'>>): PostmanItem[] {
  return METHOD_ORDER
    .map((method) => ({
      name: method,
      item: sortRestRequests(requests.filter((request) => request.method === method), options.sort)
        .map((request) => restToItem(request, options.baseUrl)),
    }))
    .filter((folder) => folder.item.length > 0);
}

function pathFolders(
  requests: RestRequest[],
  graphqlOperations: GraphQLOperation[],
  options: Required<Pick<ExportOptions, 'baseUrl' | 'sort'>>,
): PostmanItem[] {
  const grouped = new Map<string, RestRequest[]>();
  for (const request of requests) {
    const segment = request.endpoint.path.split('/').filter(Boolean)[1] ?? 'root';
    grouped.set(segment, [...grouped.get(segment) ?? [], request]);
  }

  const restFolders = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, segmentRequests]) => ({
      name: segment,
      item: sortRestRequests(segmentRequests, options.sort).map((request) => restToItem(request, options.baseUrl)),
    }));

  if (graphqlOperations.length === 0) {
    return restFolders;
  }

  return [
    ...restFolders,
    {
      name: 'graphql-operations',
      item: sortGraphqlOperations(graphqlOperations, options.sort).map((operation) => graphqlToItem(operation, options.baseUrl)),
    },
  ];
}

function restToItem(request: RestRequest, baseUrl: string): PostmanItem {
  return {
    name: `${request.method} ${request.endpoint.path}`,
    request: {
      method: request.method,
      header: [],
      url: buildPostmanUrl(baseUrl, request.endpoint.path),
    },
  };
}

function graphqlToItem(operation: GraphQLOperation, baseUrl: string): PostmanItem {
  return {
    name: operation.name,
    request: {
      method: 'POST',
      header: [{ key: 'Content-Type', value: 'application/json' }],
      body: {
        mode: 'raw',
        raw: JSON.stringify(operation.body, null, 2),
        options: { raw: { language: 'json' } },
      },
      url: buildPostmanUrl(baseUrl, '/api/graphql'),
    },
  };
}

function sortRestRequests(requests: RestRequest[], sort: SortMode): RestRequest[] {
  if (sort === 'none') return requests;
  return [...requests].sort((a, b) => `${a.endpoint.path} ${a.method}`.localeCompare(`${b.endpoint.path} ${b.method}`));
}

function sortGraphqlOperations(operations: GraphQLOperation[], sort: SortMode): GraphQLOperation[] {
  if (sort === 'none') return operations;
  return [...operations].sort((a, b) => a.name.localeCompare(b.name));
}

function buildPostmanUrl(baseUrl: string, routePath: string) {
  const raw = `${baseUrl.replace(/\/$/, '')}${routePath}`;
  if (baseUrl.includes('{{')) {
    return raw;
  }

  const parsed = new URL(raw);
  return {
    raw,
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname.split('.'),
    port: parsed.port || undefined,
    path: parsed.pathname.split('/').filter(Boolean),
  };
}

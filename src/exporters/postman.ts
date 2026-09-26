import type { GroupBy, SortMode } from './index.js';
import type { Endpoint, GraphQLOperation, HttpMethod, ScanResult } from '../types.js';
import { graphqlPathOf, parseOpenAPI } from '../generators/openapi.js';

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
  const name = options.name ?? openapi.info?.title ?? 'Routier API';
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
    variable: [
      { key: 'baseUrl', value: baseUrl === '{{baseUrl}}' ? defaultServer(openapi) : baseUrl },
      ...headerVariables(scan).map((key) => ({ key, value: '' })),
    ],
  };
}

function defaultServer(openapi: any): string {
  return openapi.servers?.[0]?.variables?.baseUrl?.default ?? 'http://localhost:3000';
}

/** Variables usadas por las cabeceras generadas (`token` para Authorization y una por cabecera personalizada). */
function headerVariables(scan: ScanResult): string[] {
  const keys = new Set<string>();
  for (const endpoint of scan.endpoints) {
    for (const meta of Object.values(endpoint.methodsMetadata ?? {})) {
      for (const header of meta?.headers ?? []) {
        keys.add(header.toLowerCase() === 'authorization' ? 'token' : header.toLowerCase());
      }
    }
  }
  return [...keys].sort();
}

function buildItems(scan: ScanResult, options: Required<Pick<ExportOptions, 'baseUrl' | 'groupBy' | 'sort'>>): PostmanItem[] {
  const restRequests = scan.endpoints
    .filter((endpoint) => endpoint.fileType !== 'graphql')
    .flatMap((endpoint) => endpoint.methods.map((method) => ({ endpoint, method })));
  const graphqlEndpointRequests = scan.endpoints
    .filter((endpoint) => endpoint.fileType === 'graphql')
    .flatMap((endpoint) => endpoint.methods.map((method) => ({ endpoint, method })));
  const graphqlOperations = sortGraphqlOperations(scan.graphqlOperations, options.sort);
  const graphqlPath = graphqlPathOf(scan);

  if (options.groupBy === 'none') {
    return [
      ...sortRestRequests([...restRequests, ...graphqlEndpointRequests], options.sort).map((request) => restToItem(request, options.baseUrl)),
      ...graphqlOperations.map((operation) => graphqlToItem(operation, options.baseUrl, graphqlPath)),
    ];
  }

  if (options.groupBy === 'method') {
    return methodFolders([...restRequests, ...graphqlEndpointRequests], options);
  }

  if (options.groupBy === 'path') {
    return pathFolders([...restRequests, ...graphqlEndpointRequests], graphqlOperations, graphqlPath, options);
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
            .map((operation) => graphqlToItem(operation, options.baseUrl, graphqlPath)),
        },
        {
          name: 'Mutations',
          item: graphqlOperations
            .filter((operation) => operation.type === 'mutation')
            .map((operation) => graphqlToItem(operation, options.baseUrl, graphqlPath)),
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
  graphqlPath: string,
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
      item: sortGraphqlOperations(graphqlOperations, options.sort).map((operation) => graphqlToItem(operation, options.baseUrl, graphqlPath)),
    },
  ];
}

function restToItem(request: RestRequest, baseUrl: string): PostmanItem {
  const meta = request.endpoint.methodsMetadata?.[request.method];
  const headers = meta?.headers?.map((header) => {
    const isAuth = header.toLowerCase() === 'authorization';
    return {
      key: header,
      value: isAuth ? 'Bearer {{token}}' : `{{${header.toLowerCase()}}}`,
      type: 'text' as const,
    };
  }) ?? [];

  if (meta?.body) {
    headers.push({ key: 'Content-Type', value: 'application/json', type: 'text' as const });
  }

  const body = meta?.body ? {
    mode: 'raw' as const,
    raw: meta.body,
    options: {
      raw: {
        language: 'json' as const,
      },
    },
  } : undefined;

  return {
    name: `${request.method} ${request.endpoint.path}`,
    request: {
      method: request.method,
      header: headers,
      body,
      url: buildPostmanUrl(baseUrl, request.endpoint.path, meta?.query),
    },
  };
}

function graphqlToItem(operation: GraphQLOperation, baseUrl: string, graphqlPath: string): PostmanItem {
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
      url: buildPostmanUrl(baseUrl, graphqlPath),
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

function buildPostmanUrl(baseUrl: string, routePath: string, query: string[] = []) {
  const base = baseUrl.replace(/\/$/, '');
  const queryString = query.length > 0 ? `?${query.map((key) => `${key}=`).join('&')}` : '';
  const raw = `${base}${routePath}${queryString}`;
  const pathSegments = routePath.split('/').filter(Boolean);
  const variables = pathSegments.filter((segment) => segment.startsWith(':')).map((segment) => ({ key: segment.slice(1), value: '' }));
  const extras = {
    path: pathSegments,
    ...(query.length > 0 ? { query: query.map((key) => ({ key, value: '' })) } : {}),
    ...(variables.length > 0 ? { variable: variables } : {}),
  };

  if (base.includes('{{')) {
    return { raw, host: [base], ...extras };
  }

  const parsed = new URL(base);
  const basePath = parsed.pathname.split('/').filter(Boolean);
  return {
    raw,
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname.split('.'),
    port: parsed.port || undefined,
    ...extras,
    path: [...basePath, ...pathSegments],
  };
}

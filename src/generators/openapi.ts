import type { Endpoint, GraphQLOperation, HttpMethod, JsonSchema, MethodMetadata, ScanResult } from '../types.js';

export const DEFAULT_GRAPHQL_PATH = '/api/graphql';

export interface OpenAPIOptions {
  baseUrl: string;
  /** Título del documento (por defecto, `Routier API`). */
  title?: string;
  /** Versión de la API documentada (por defecto, `1.0.0`). */
  version?: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function toPascal(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function operationIdFor(method: string, routePath: string, used: Set<string>): string {
  const segments = routePath
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `By${toPascal(segment.slice(1))}` : toPascal(segment)));
  const base = `${method.toLowerCase()}${segments.join('') || 'Root'}`;
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}${i}`;
  used.add(id);
  return id;
}

/** Tag por recurso: primer segmento estático después de `/api` (p. ej. `/api/users/:id` -> `users`). */
function tagFor(routePath: string): string {
  const segments = routePath.split('/').filter((segment) => segment && !segment.startsWith(':'));
  const resource = segments[0] === 'api' ? segments[1] : segments[0];
  return resource ?? 'root';
}

function convertPathToOpenAPI(routePath: string) {
  const params = [...routePath.matchAll(/:([a-zA-Z0-9_]+)/g)].map((match) => match[1]);
  const openapiPath = routePath.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
  return { openapiPath, params };
}

export function graphqlPathOf(scan: Pick<ScanResult, 'endpoints'>): string {
  return scan.endpoints.find((endpoint) => endpoint.fileType === 'graphql')?.path ?? DEFAULT_GRAPHQL_PATH;
}

function buildRestOperation(endpoint: Endpoint, method: HttpMethod, openapiPath: string, usedIds: Set<string>) {
  const meta = endpoint.methodsMetadata?.[method];
  const parameters: any[] = [];
  let requiresAuth = false;

  for (const header of meta?.headers ?? []) {
    if (header.toLowerCase() === 'authorization') {
      requiresAuth = true;
      continue;
    }
    parameters.push({ name: header, in: 'header', required: false, schema: { type: 'string' } });
  }

  for (const name of meta?.query ?? []) {
    parameters.push({ name, in: 'query', required: false, schema: { type: 'string' } });
  }

  const operation: any = {
    operationId: operationIdFor(method, endpoint.path, usedIds),
    summary: `${method} ${openapiPath}`,
    tags: [tagFor(endpoint.path)],
  };

  if (parameters.length > 0) operation.parameters = parameters;
  if (requiresAuth) operation.security = [{ bearerAuth: [] }];

  if (meta?.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    let example: unknown;
    try {
      example = JSON.parse(meta.body);
    } catch {
      example = undefined;
    }
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: meta.bodySchema ?? { type: 'object' },
          ...(example !== undefined ? { example } : {}),
        },
      },
    };
  }

  operation.responses = { '200': { description: 'Successful response' } };
  if (requiresAuth) operation.responses['401'] = { description: 'Unauthorized' };

  return { operation, requiresAuth };
}

function buildGraphQLPathItem(operations: GraphQLOperation[], endpoint: Endpoint | undefined) {
  const examples = Object.fromEntries(
    operations.map((operation) => [
      `${operation.type}_${operation.name}`,
      {
        summary: `${operation.type === 'query' ? 'Query' : 'Mutation'}: ${operation.name}`,
        value: operation.body,
      },
    ]),
  );

  return {
    ...(endpoint ? { 'x-routier-source-file': endpoint.sourceFile, 'x-routier-router': endpoint.router } : {}),
    'x-routier-graphql-endpoint': true,
    post: {
      operationId: 'graphql',
      summary: 'GraphQL endpoint',
      tags: ['GraphQL'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string' },
                variables: { type: 'object', additionalProperties: true },
                operationName: { type: 'string' },
              },
            },
            ...(operations.length > 0 ? { examples } : {}),
          },
        },
      },
      responses: { '200': { description: 'GraphQL response' } },
      'x-routier-graphql-operations': operations.map((operation) => ({
        type: operation.type,
        name: operation.name,
        arguments: operation.arguments,
        query: operation.body.query,
        variables: operation.body.variables,
        sourceFile: operation.sourceFile,
      })),
    },
  };
}

export function generateOpenAPI(scan: ScanResult, options: OpenAPIOptions) {
  const paths: Record<string, any> = {};
  const usedIds = new Set<string>(['graphql']);
  const tags = new Set<string>();
  let usesAuth = false;

  for (const endpoint of scan.endpoints) {
    if (endpoint.fileType === 'graphql') continue;

    const { openapiPath, params } = convertPathToOpenAPI(endpoint.path);
    const pathItem = paths[openapiPath] ?? {
      'x-routier-source-file': endpoint.sourceFile,
      'x-routier-router': endpoint.router,
      ...(params.length > 0
        ? { parameters: params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) }
        : {}),
    };
    paths[openapiPath] = pathItem;

    for (const method of endpoint.methods) {
      const { operation, requiresAuth } = buildRestOperation(endpoint, method, openapiPath, usedIds);
      usesAuth ||= requiresAuth;
      operation.tags.forEach((tag: string) => tags.add(tag));
      pathItem[method.toLowerCase()] = operation;
    }
  }

  const graphqlEndpoint = scan.endpoints.find((endpoint) => endpoint.fileType === 'graphql');
  if (graphqlEndpoint || scan.graphqlOperations.length > 0) {
    paths[graphqlPathOf(scan)] = buildGraphQLPathItem(scan.graphqlOperations, graphqlEndpoint);
    tags.add('GraphQL');
  }

  const isVariable = options.baseUrl.includes('{');

  return {
    openapi: '3.0.3',
    info: {
      title: options.title ?? 'Routier API',
      version: options.version ?? '1.0.0',
      description: 'Generated by Routier',
    },
    servers: [
      isVariable
        ? {
            url: '{baseUrl}',
            variables: { baseUrl: { default: 'http://localhost:3000', description: 'Base URL of the server' } },
          }
        : { url: options.baseUrl },
    ],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    ...(usesAuth
      ? { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } }
      : {}),
  };
}

function metadataFromOperation(operation: any): MethodMetadata | undefined {
  const meta: MethodMetadata = {};
  const params: any[] = operation.parameters ?? [];

  const headers = params.filter((param) => param.in === 'header').map((param) => param.name as string);
  const hasBearer = (operation.security ?? []).some((requirement: any) => 'bearerAuth' in requirement);
  if (hasBearer) headers.unshift('Authorization');
  if (headers.length > 0) meta.headers = headers;

  const query = params.filter((param) => param.in === 'query').map((param) => param.name as string);
  if (query.length > 0) meta.query = query;

  const media = operation.requestBody?.content?.['application/json'];
  if (media) {
    if (media.example !== undefined) meta.body = JSON.stringify(media.example, null, 2);
    if (media.schema) meta.bodySchema = media.schema as JsonSchema;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Reconstruye el modelo interno (`ScanResult`) desde un documento generado por `generateOpenAPI`. */
export function parseOpenAPI(openapi: any): ScanResult {
  const endpoints: Endpoint[] = [];
  const graphqlOperations: GraphQLOperation[] = [];

  for (const [openapiPath, pathItem] of Object.entries<any>(openapi.paths ?? {})) {
    const routePath = openapiPath.replace(/\{([^}]+)\}/g, ':$1');
    const sourceFile = pathItem['x-routier-source-file'] ?? '';
    const router = pathItem['x-routier-router'] ?? 'app';

    if (pathItem['x-routier-graphql-endpoint']) {
      for (const operation of pathItem.post?.['x-routier-graphql-operations'] ?? []) {
        graphqlOperations.push({
          type: operation.type,
          name: operation.name,
          arguments: operation.arguments ?? [],
          variables: operation.variables ?? {},
          body: { query: operation.query, variables: operation.variables ?? {} },
          sourceFile: operation.sourceFile ?? '',
        });
      }
      endpoints.push({ path: routePath, methods: ['POST'], fileType: 'graphql', sourceFile, router });
      continue;
    }

    const methods: HttpMethod[] = [];
    const methodsMetadata: Endpoint['methodsMetadata'] = {};
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const upper = method.toUpperCase() as HttpMethod;
      methods.push(upper);
      const meta = metadataFromOperation(operation);
      if (meta) methodsMetadata[upper] = meta;
    }

    if (methods.length > 0) {
      endpoints.push({
        path: routePath,
        methods,
        fileType: 'rest',
        sourceFile,
        router,
        methodsMetadata: Object.keys(methodsMetadata).length > 0 ? methodsMetadata : undefined,
      });
    }
  }

  return { endpoints, graphqlOperations, warnings: [] };
}

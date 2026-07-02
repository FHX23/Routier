export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type RouterType = 'app' | 'pages';

export interface Endpoint {
  path: string;
  methods: HttpMethod[];
  fileType: 'rest' | 'graphql';
  sourceFile: string;
  router: RouterType;
  methodsMetadata?: Record<HttpMethod, { headers?: string[]; body?: string }>;
}

export interface GraphQLArgument {
  name: string;
  type: string;
  required: boolean;
}

export interface GraphQLOperation {
  type: 'query' | 'mutation';
  name: string;
  arguments: GraphQLArgument[];
  variables: Record<string, unknown>;
  body: {
    query: string;
    variables: Record<string, unknown>;
  };
  sourceFile: string;
}

export interface ScanResult {
  endpoints: Endpoint[];
  graphqlOperations: GraphQLOperation[];
  warnings: string[];
}

export interface ScanOptions {
  cwd?: string;
  graphqlSchema?: string;
  exclude?: string[];
}

export interface RoutierConfig {
  framework?: string;
  out?: string;
  baseUrl?: string;
  format?: 'postman' | 'insomnia' | 'openapi' | 'all';
  groupBy?: 'type' | 'method' | 'path' | 'none';
  sort?: 'alpha' | 'none';
  graphqlSchema?: string;
  exclude?: string[];
}

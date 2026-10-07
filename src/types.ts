export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export type Framework = 'next' | 'express' | 'fastify' | 'nestjs';

/** Origen de un endpoint: App/Pages Router de Next.js o el framework backend que lo declara. */
export type RouterType = 'app' | 'pages' | 'express' | 'fastify' | 'nestjs';

/** Subconjunto de JSON Schema (compatible con OpenAPI 3.0) que Routier puede inferir. */
export interface JsonSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  format?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  nullable?: boolean;
  default?: unknown;
  anyOf?: JsonSchema[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  /** Extensión: `z.date()` exige un objeto Date, que no puede viajar en JSON. */
  'x-date-object'?: boolean;
  /** Extensión: el objeto viene de una validación o tipo explícito (no de campos leídos en el código). */
  'x-validated'?: boolean;
}

/** Autenticación que exige una operación. */
export type AuthRequirement =
  | { type: 'bearer'; optional?: boolean }
  | { type: 'session'; cookie: string };

/** Tipo de contenido del body de una request. */
export type BodyContentType = 'application/json' | 'multipart/form-data' | 'text/plain';

export interface MethodMetadata {
  /** Autenticación requerida (Bearer o sesión por cookie). */
  auth?: AuthRequirement;
  /** Cabeceras leídas por el handler (`Authorization` indica autenticación Bearer). */
  headers?: string[];
  /** Parámetros de query string leídos por el handler. */
  query?: string[];
  /** Schema de la query según el validador: tipos de cada parámetro y cuáles son obligatorios. */
  querySchema?: JsonSchema;
  /** Body JSON de ejemplo (serializado). */
  body?: string;
  /** Schema del body inferido (por ejemplo desde Zod). */
  bodySchema?: JsonSchema;
  /** Tipo de contenido del body (por defecto JSON). */
  bodyContentType?: BodyContentType;
}

export interface Endpoint {
  path: string;
  methods: HttpMethod[];
  fileType: 'rest' | 'graphql';
  sourceFile: string;
  router: RouterType;
  methodsMetadata?: Partial<Record<HttpMethod, MethodMetadata>>;
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
  /** Framework a analizar. `auto` (por defecto) lo detecta desde el `package.json` del proyecto. */
  framework?: Framework | 'auto';
  graphqlSchema?: string;
  exclude?: string[];
}

export interface RoutierConfig {
  framework?: Framework | 'auto';
  out?: string;
  baseUrl?: string;
  format?: 'postman' | 'insomnia' | 'openapi' | 'all';
  groupBy?: 'type' | 'method' | 'path' | 'none';
  sort?: 'alpha' | 'none';
  graphqlSchema?: string;
  exclude?: string[];
}

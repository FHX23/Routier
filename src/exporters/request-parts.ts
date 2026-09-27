import type { AuthRequirement, JsonSchema, MethodMetadata, ScanResult } from '../types.js';
import { exampleFromSchema } from '../parsers/shared/examples.js';

/**
 * Partes comunes de una request para los exportadores (Postman e Insomnia):
 * cabeceras, variables de colección y campos de formularios multipart.
 */

export type VariableStyle = 'postman' | 'insomnia';

export interface HeaderPart {
  name: string;
  value: string;
  disabled?: boolean;
}

export interface GraphqlTarget {
  path: string;
  meta?: MethodMetadata;
}

/** Ruta y metadatos (auth) del endpoint GraphQL del proyecto. */
export function graphqlTargetOf(scan: ScanResult, path: string): GraphqlTarget {
  const endpoint = scan.endpoints.find((candidate) => candidate.fileType === 'graphql');
  return { path, meta: endpoint?.methodsMetadata?.POST };
}

/** Headers de una operación GraphQL: auth del endpoint + Content-Type JSON. */
export function graphqlHeaders(target: GraphqlTarget, style: VariableStyle): HeaderPart[] {
  return [
    ...requestHeaders(target.meta, style).filter((header) => header.name !== 'Content-Type'),
    { name: 'Content-Type', value: 'application/json' },
  ];
}

/** Nombre de variable válido para ambos motores de plantillas (Nunjucks no admite guiones). */
export function variableName(header: string, style: VariableStyle): string {
  const lower = header.toLowerCase();
  return style === 'insomnia' ? lower.replace(/[^a-z0-9_]/g, '_') : lower;
}

export function template(name: string, style: VariableStyle): string {
  return style === 'postman' ? `{{${name}}}` : `{{ _.${name} }}`;
}

export function authOf(meta: MethodMetadata | undefined): AuthRequirement | undefined {
  if (meta?.auth) return meta.auth;
  return meta?.headers?.some((header) => header.toLowerCase() === 'authorization') ? { type: 'bearer' } : undefined;
}

export function requestHeaders(meta: MethodMetadata | undefined, style: VariableStyle): HeaderPart[] {
  const headers: HeaderPart[] = [];
  const auth = authOf(meta);

  if (auth?.type === 'bearer') {
    headers.push({ name: 'Authorization', value: `Bearer ${template('token', style)}`, ...(auth.optional ? { disabled: true } : {}) });
  } else if (auth?.type === 'session') {
    headers.push({ name: 'Cookie', value: `${auth.cookie}=${template('session', style)}` });
  }

  for (const header of meta?.headers ?? []) {
    if (header.toLowerCase() === 'authorization') continue;
    headers.push({ name: header, value: template(variableName(header, style), style) });
  }

  const contentType = meta?.bodyContentType ?? (meta?.body ? 'application/json' : undefined);
  if (contentType === 'application/json' || contentType === 'text/plain') {
    headers.push({ name: 'Content-Type', value: contentType });
  }
  return headers;
}

/** Variables de colección/entorno que usan las cabeceras generadas. */
export function variablesUsed(scan: ScanResult, style: VariableStyle): string[] {
  const keys = new Set<string>();
  for (const endpoint of scan.endpoints) {
    for (const meta of Object.values(endpoint.methodsMetadata ?? {})) {
      const auth = authOf(meta);
      if (auth?.type === 'bearer') keys.add('token');
      if (auth?.type === 'session') keys.add('session');
      for (const header of meta?.headers ?? []) {
        if (header.toLowerCase() !== 'authorization') keys.add(variableName(header, style));
      }
    }
  }
  return [...keys].sort();
}

export interface FormField {
  name: string;
  file: boolean;
  value: string;
}

/** Campos de un body multipart a partir de su schema (los binarios son archivos). */
export function formFields(schema: JsonSchema | undefined): FormField[] {
  return Object.entries(schema?.properties ?? {}).map(([name, property]) => {
    const item = property.type === 'array' ? property.items ?? {} : property;
    const file = item.format === 'binary';
    const example = file ? '' : exampleFromSchema(item, name);
    const value = example === null || example === undefined ? '' : typeof example === 'object' ? JSON.stringify(example) : String(example);
    return { name, file, value };
  });
}

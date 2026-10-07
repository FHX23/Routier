import type { JsonSchema, MethodMetadata } from '../../types.js';
import { exampleFromSchema } from './examples.js';
import type { RequestBodyInference } from './flow.js';

/** Vuelca un body inferido en los metadatos del método (schema, ejemplo y tipo de contenido). */
export function applyBody(meta: MethodMetadata, inference: RequestBodyInference | null | undefined) {
  if (!inference) return;
  meta.bodyContentType = inference.contentType;
  if (inference.contentType === 'text/plain') return;

  // Un body que se lee pero del que no se sabe nada se documenta como objeto vacío,
  // para que la request no llegue sin body (el servidor fallaría al parsear el JSON).
  const schema = inference.schema ?? { type: 'object' };
  meta.bodySchema = schema;
  if (inference.contentType === 'application/json') {
    meta.body = JSON.stringify(exampleFromSchema(schema) ?? {}, null, 2);
  }
}

/** Vuelca el schema de la query de un validador: agrega sus parámetros y guarda tipos y obligatorios. */
export function applyQuerySchema(meta: MethodMetadata, schema: JsonSchema | null | undefined) {
  const names = Object.keys(schema?.properties ?? {});
  if (!schema || names.length === 0) return;
  meta.query = [...(meta.query ?? []), ...names.filter((name) => !meta.query?.includes(name))];
  meta.querySchema = schema;
}

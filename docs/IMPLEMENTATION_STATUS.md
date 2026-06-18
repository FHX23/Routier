# Estado de Implementacion del MVP

## Listo

- Scanner Next.js con `cwd` configurable.
  - Implementado en `src/parsers/next/index.ts`.
  - Detecta App Router y Pages Router.
  - Ignora `node_modules`, `.next`, `dist` y `routier-exports`.

- Normalizacion de rutas Next.js.
  - Convierte route groups `(admin)` en segmentos invisibles.
  - Convierte `[id]`, `[...slug]` y `[[...path]]` a `:id`, `:slug` y `:path`.

- Modelo interno unificado.
  - Implementado en `src/types.ts`.
  - Expone `Endpoint`, `GraphQLOperation` y `ScanResult`.

- Parser GraphQL AST.
  - Implementado en `src/parsers/graphql/index.ts`.
  - Usa `graphql.parse`.
  - Lee `.graphql`, `.gql` y schemas estaticos en TypeScript con `gql` o `typeDefs`.
  - Extrae operaciones `Query` y `Mutation`.
  - Genera bodies basicos con `query` y `variables`.

- Exportador Postman.
  - Implementado en `src/exporters/postman.ts`.
  - Genera Collection v2.1 con requests REST y GraphQL.
  - Agrupa por defecto en `REST` y `GraphQL`, con `Queries`, `Mutations` y `Endpoint`.

- Exportador Insomnia.
  - Implementado en `src/exporters/insomnia.ts`.
  - Genera export format 4 con workspace, environment y requests.
  - Genera `request_group` para ordenar visualmente la coleccion.

- CLI no interactivo.
  - Implementado en `src/index.ts`.
  - Comandos disponibles: `scan` y `export`.
  - Opciones disponibles: `--cwd`, `--framework`, `--format`, `--group-by`, `--sort`, `--out`, `--base-url`, `--graphql-schema`.

- Guia de uso.
  - Implementada en `docs/USAGE.md`.
  - Explica build local, scan, export, agrupacion, GraphQL e importacion en Postman/Insomnia.

- Fixtures fuera de `src`.
  - Implementados en `fixtures/next-app` y `fixtures/graphql-ts`.
  - Evitan que archivos demo entren al build del paquete.

- Pruebas automatizadas.
  - Implementadas en `tests/next-parser.test.ts`, `tests/graphql-parser.test.ts` y `tests/exporters.test.ts`.
  - Cubren parser Next, parser GraphQL y exportadores.

## Parcial

- Importacion manual en Postman e Insomnia.
  - Los archivos se generan con estructuras nativas esperadas.
  - Falta validacion manual dentro de las apps de escritorio.

## Pendiente

- Parser GraphQL para schemas dinamicos construidos en runtime.
- Inferencia avanzada de body REST.
- Configuracion persistente `routier.json`.
- Soporte para frameworks adicionales.

## Como se implemento

1. Se movieron las rutas de ejemplo fuera de `src` hacia `fixtures`.
2. Se creo un contrato comun en `src/types.ts`.
3. Se adapto el scanner de Next.js para recibir `cwd`.
4. Se agrego parser GraphQL basado en SDL estatico y `graphql.parse`.
5. Se agregaron exportadores independientes para Postman e Insomnia.
6. Se reemplazo el CLI interactivo por comandos no interactivos.
7. Se agregaron pruebas automatizadas con `node:test` y `tsx`.
8. Se agrego agrupacion visual por tipo, metodo, path o salida plana.
9. Se agrego una guia de uso local en Markdown.

## Comandos de verificacion

```bash
corepack pnpm test
corepack pnpm run build
node dist/index.js scan --cwd fixtures/next-app
node dist/index.js export --cwd fixtures/next-app --format all --out routier-exports --base-url http://localhost:3000
node dist/index.js export --cwd fixtures/next-app --format all --group-by type --sort alpha
```

## Verificacion ejecutada

- `corepack pnpm run build`: OK.
- `corepack pnpm test`: OK, 7 pruebas pasando.
- `node dist/index.js scan --cwd fixtures/next-app`: OK, detecta 5 endpoints REST/HTTP y 3 operaciones GraphQL.
- `node dist/index.js export --cwd fixtures/next-app --format all --out routier-exports --base-url http://localhost:3000`: OK, genera Postman e Insomnia.
- `node dist/index.js export --cwd fixtures/next-app --format all --group-by type --sort alpha`: OK, genera carpetas `REST` y `GraphQL`.
- `node dist/index.js export --cwd fixtures/next-app --format postman --group-by none`: OK, conserva salida plana.

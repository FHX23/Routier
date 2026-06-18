# MVP Routier

## Objetivo

Routier debe funcionar como un CLI npm capaz de escanear un proyecto Next.js, detectar endpoints REST y GraphQL, y generar archivos nativos importables en Postman e Insomnia.

## Alcance del MVP

- Soporte inicial para Next.js App Router y Pages Router.
- Deteccion de metodos HTTP exportados en `route.ts` / `route.js`.
- Normalizacion de rutas dinamicas de Next.js a formato `:param`.
- Deteccion de GraphQL desde schemas `.graphql` / `.gql` y schemas estaticos en TypeScript con `gql` o `typeDefs`.
- Exportacion nativa a Postman Collection v2.1.
- Exportacion nativa a Insomnia export format 4.
- Agrupacion visual de requests por tipo, metodo, path o salida plana.
- CLI no interactivo para facilitar uso en scripts y CI.
- Guia de uso local para probar antes de publicar.

## Comandos esperados

```bash
routier scan --cwd .
routier export --framework next --format all --out ./routier-exports --base-url http://localhost:3000
routier export --framework next --format all --group-by type --sort alpha
```

Defaults del MVP:

- `--framework next`
- `--format all`
- `--out ./routier-exports`
- `--base-url {{baseUrl}}`
- `--group-by type`
- `--sort alpha`

## Arquitectura

- Scanner Next.js: encuentra rutas App Router y Pages Router desde un `cwd` configurable.
- Parser GraphQL: busca SDL estatico, parsea el schema y extrae operaciones `Query` y `Mutation`.
- Modelo interno: transforma todo a `ScanResult`, con endpoints REST, operaciones GraphQL y warnings.
- Exportadores: generan JSON de Postman e Insomnia desde el mismo modelo interno.
- Agrupador de salida: separa REST de GraphQL y organiza GraphQL en Queries y Mutations.
- Fixtures y pruebas: viven fuera de `src` para no contaminar el paquete publicado.

## Criterios de exito

- El CLI lista endpoints con `routier scan`.
- El CLI genera `routier-postman.json` y `routier-insomnia.json`.
- Postman recibe requests REST y GraphQL.
- Insomnia recibe workspace, environment y requests REST/GraphQL.
- Postman e Insomnia muestran carpetas utiles para proyectos grandes.
- Las rutas dinamicas usan `:param`.
- Las operaciones GraphQL tienen body JSON con `query` y `variables`.

## Fuera de alcance

- Express, NestJS, Fastify y otros frameworks.
- Inferencia de autenticacion.
- Inferencia avanzada de body REST.
- Configuracion persistente `routier.json`.
- Resolucion de schemas GraphQL construidos dinamicamente en runtime.

# Guia de uso de Routier

Routier es un CLI local para analizar proyectos Next.js y generar colecciones importables en Postman e Insomnia.

## Compilar el CLI

Desde la carpeta del paquete:

```bash
corepack pnpm run build
```

## Analizar un proyecto Next.js

```bash
node dist/index.js scan --cwd "C:\ruta\a\tu\proyecto-next"
```

El comando lista:

- Endpoints REST/HTTP detectados.
- Metodos HTTP por ruta.
- Operaciones GraphQL detectadas.
- Warnings cuando un schema GraphQL no se puede leer.

## Exportar a Postman e Insomnia

```bash
node dist/index.js export --cwd "C:\ruta\a\tu\proyecto-next" --format all --out routier-exports --base-url http://localhost:3000
```

Esto crea dentro del proyecto analizado:

```text
routier-exports/
  routier-postman.json
  routier-insomnia.json
```

## Formatos disponibles

```bash
--format all
--format postman
--format insomnia
```

## Agrupacion visual

Por defecto Routier agrupa la salida para que sea mas legible:

```text
REST
  GET
  POST
  PUT
  PATCH
  DELETE
GraphQL
  Queries
  Mutations
  Endpoint
```

Puedes controlar la agrupacion con:

```bash
--group-by type
--group-by method
--group-by path
--group-by none
```

Recomendado para proyectos reales:

```bash
node dist/index.js export --cwd "C:\ruta\a\tu\proyecto-next" --format all --group-by type --sort alpha
```

Si quieres una lista plana como la primera version:

```bash
node dist/index.js export --cwd "C:\ruta\a\tu\proyecto-next" --format all --group-by none
```

## Ordenamiento

```bash
--sort alpha
--sort none
```

`alpha` ordena endpoints y operaciones por nombre/ruta. `none` respeta el orden del scanner.

## GraphQL

Routier detecta GraphQL desde:

- Archivos `.graphql`.
- Archivos `.gql`.
- Plantillas estaticas TypeScript con `gql`.
- Plantillas estaticas TypeScript con `typeDefs`.

Tambien puedes indicar el schema manualmente:

```bash
node dist/index.js export --cwd "C:\ruta\a\tu\proyecto-next" --graphql-schema schema.graphql
```

Limitacion actual: schemas construidos dinamicamente en runtime se omiten y generan warning.

## Probar como paquete global antes de publicar

Desde la carpeta de Routier:

```bash
npm.cmd link
```

Luego, desde un proyecto Next.js:

```bash
routier scan --cwd .
routier export --cwd . --format all --group-by type --out routier-exports --base-url http://localhost:3000
```

## Importar en las apps

Postman:

1. Abre Postman.
2. Import.
3. Selecciona `routier-postman.json`.

Insomnia:

1. Abre Insomnia.
2. Import.
3. Selecciona `routier-insomnia.json`.

## Soporte actual

- Next.js App Router.
- Next.js Pages Router.
- REST endpoints basicos.
- GraphQL Query y Mutation desde SDL estatico.
- Exportacion Postman.
- Exportacion Insomnia.

## Pendiente

- Express, NestJS y Fastify.
- Inferencia avanzada de bodies REST.
- Deteccion de autenticacion.
- Configuracion persistente `routier.json`.

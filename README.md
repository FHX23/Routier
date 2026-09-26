# Routier

[![npm version](https://img.shields.io/npm/v/routier?style=flat-square)](https://www.npmjs.com/package/routier)
[![CI](https://img.shields.io/github/actions/workflow/status/FHX23/Routier/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/FHX23/Routier/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/routier?style=flat-square)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-ISC-blue?style=flat-square)](./LICENSE)

**Routier** scans the source code of your API and generates ready-to-import **OpenAPI 3**, **Postman** and **Insomnia** collections — no decorators, annotations or running server required.

It supports **Next.js** (App Router and Pages Router), **Express**, **Fastify**, **NestJS** and **GraphQL** schemas, and infers auth headers, query parameters and example request bodies from your Zod schemas, JSON Schemas and DTOs.

[Leer en español](./README.es.md)

```text
$ npx routier export --base-url http://localhost:3000

●  12 REST endpoints, 4 GraphQL operations
◆  Written routier-exports/routier-openapi.json
◆  Written routier-exports/routier-postman.json
◆  Written routier-exports/routier-insomnia.json
```

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [What Routier detects](#what-routier-detects)
- [CLI reference](#cli-reference)
- [Configuration file](#configuration-file)
- [Using Routier as a library](#using-routier-as-a-library)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

## Installation

Routier requires **Node.js 22.12 or newer**.

```bash
# Run it once without installing
npx routier scan

# Or add it to your project
npm install --save-dev routier
pnpm add -D routier

# Or install it globally
npm install -g routier
```

## Quick start

From the root of your project:

```bash
# 1. See what Routier finds
routier scan

# 2. Generate the collections
routier export --base-url http://localhost:3000
```

The files are written to `./routier-exports` inside the scanned project:

| File | Import it into |
| --- | --- |
| `routier-openapi.json` | Swagger UI, Redoc, Bruno, Hoppscotch, Scalar, Postman, Insomnia… |
| `routier-postman.json` | Postman → **Import** → select the file |
| `routier-insomnia.json` | Insomnia → **Import** → select the file |

The collections include a `baseUrl` variable plus a `token` variable used by every request that needs `Authorization: Bearer …`, so you only fill them in once.

## What Routier detects

The framework is detected from your `package.json`. Use `--framework` to force one.

| | Routes | Auth & headers | Query params | Request body |
| --- | --- | --- | --- | --- |
| **Next.js** | `app/**/route.ts` handlers, `pages/api/**` (methods inferred from `req.method` checks), route groups, dynamic and catch-all segments, `export { handler as GET }`, `export const { GET, POST } = handlers` | `req.headers.get()`, `headers()` from `next/headers`, `req.headers[...]` | `searchParams.get()`, `req.query` | Zod `schema.parse(await req.json())` |
| **Express** | `app.get()`, `router.post()`, `router.route('/x').get().post()`, nested `app.use('/prefix', router)` across ESM and CommonJS files | auth middlewares (`requireAuth`, `passport.authenticate`, `verifyJwt`…), `req.get()`, `req.header()` | `req.query` | validator middlewares (`validate(schema)`) and `schema.parse(req.body)` |
| **Fastify** | `fastify.get()`, `fastify.route({ method, url })`, `register(plugin, { prefix })`, inline plugins, `@fastify/autoload` | `onRequest` / `preHandler` hooks and `addHook` with auth functions | `schema.querystring`, `request.query` | `schema.body` (JSON Schema or Zod) |
| **NestJS** | `@Controller` + `@Get/@Post/…`, `setGlobalPrefix`, URI versioning and `@Version` | `@UseGuards(AuthGuard)`, `@ApiBearerAuth`, `@Public()` opt-out, `@Headers('x')` | `@Query('x')`, `@Query() dto` | `@Body() dto` with class-validator DTOs, `PartialType`/`PickType`/`OmitType`, `ZodValidationPipe` |
| **GraphQL** | `.graphql` / `.gql` files and static `gql` / `typeDefs` templates, `extend type`, custom root types | — | — | variables generated for scalars, enums and input objects |

Zod support covers Zod 3 and 4: `z.object`, nested objects, arrays, enums, literals, unions, records, `z.email()`/`z.uuid()`/`z.url()`, `.optional()`, `.nullable()`, `.default()`, `.extend()`, `.pick()`, `.omit()`, `.partial()`, and schemas imported from other files (relative paths and the `@/` alias).

Example of what Routier produces from a Next.js handler:

```ts
// app/api/posts/[id]/route.ts
import { updatePostSchema } from '@/lib/schemas';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get('authorization');
  const data = updatePostSchema.parse(await req.json());
  // ...
}
```

```jsonc
// routier-openapi.json (excerpt)
"/api/posts/{id}": {
  "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
  "patch": {
    "operationId": "patchApiPostsById",
    "tags": ["posts"],
    "security": [{ "bearerAuth": [] }],
    "requestBody": {
      "content": {
        "application/json": {
          "schema": { "type": "object", "properties": { "title": { "type": "string" }, "email": { "type": "string", "format": "email" } } },
          "example": { "title": "string", "email": "user@example.com" }
        }
      }
    }
  }
}
```

## CLI reference

### `routier scan`

Lists the endpoints and GraphQL operations found in a project.

| Option | Description | Default |
| --- | --- | --- |
| `--cwd <path>` | Project directory | `.` |
| `--framework <name>` | `auto`, `next`, `express`, `fastify` or `nestjs` | `auto` |
| `--graphql-schema <path>` | Explicit GraphQL schema file | auto-detected |
| `--exclude <globs...>` | Glob patterns to skip | — |
| `--json` | Print the raw result as JSON (useful in scripts and CI) | — |
| `--no-interactive` | Never prompt to create `routier.json` | — |

### `routier export`

Generates the output files. Accepts every `scan` option except `--json`, plus:

| Option | Description | Default |
| --- | --- | --- |
| `--format <format>` | `all`, `openapi`, `postman` or `insomnia` | `all` |
| `--out <path>` | Output directory, relative to `--cwd` | `./routier-exports` |
| `--base-url <url>` | Base URL for requests | `{{baseUrl}}` variable |
| `--group-by <mode>` | Collection folders: `type` (REST / GraphQL), `method`, `path` or `none` | `type` |
| `--sort <mode>` | `alpha` or `none` | `alpha` |

Examples:

```bash
routier export --format openapi
routier export --framework express --cwd ./apps/api
routier export --format postman --group-by method --out ./collections
routier scan --json > routes.json
```

## Configuration file

Instead of repeating flags, create a `routier.json` in the project root. Every key is optional and CLI flags always take precedence:

```json
{
  "framework": "auto",
  "out": "./routier-exports",
  "baseUrl": "http://localhost:3000",
  "format": "all",
  "groupBy": "type",
  "sort": "alpha",
  "graphqlSchema": "./schema.graphql",
  "exclude": ["**/mocks/**", "**/temp/**"]
}
```

When you run Routier in an interactive terminal with no flags and no `routier.json`, it offers to create the file for you. Pass `--no-interactive` (or run it in CI) to skip the prompt.

## Using Routier as a library

```ts
import { scanProject, generateOpenAPI, generatePostmanCollection } from 'routier';

const scan = await scanProject({ cwd: './my-api', framework: 'auto' });
const openapi = generateOpenAPI(scan, { baseUrl: 'https://api.example.com', title: 'My API' });
const postman = generatePostmanCollection(openapi, { baseUrl: 'https://api.example.com', groupBy: 'method' });
```

Also exported: `scanNextRoutes`, `scanGraphQLSchema`, `parseOpenAPI`, `generateInsomniaExport`, `writeExports`, `loadConfig`, `detectFrameworks` and all the TypeScript types (`ScanResult`, `Endpoint`, `JsonSchema`, …).

## Limitations

Routier reads your code statically and never executes it, so it only sees what is written literally:

- Routes whose paths are built at runtime (`app.get(prefix + '/x')`, loops over arrays of routes) are skipped.
- Schemas must be declared with Zod, JSON Schema object literals or class-validator DTOs; TypeBox, Joi and Yup are not interpreted yet.
- GraphQL operations are read from SDL. Code-first schemas (NestJS `@Resolver`, Pothos, TypeGraphQL…) are only picked up if the generated `.graphql` file is committed.
- Example values are generic (`"string"`, `10`, `user@example.com`), not real data.

If Routier misses a pattern you use, please [open an issue](https://github.com/FHX23/Routier/issues/new/choose) with a small snippet.

## Roadmap

- [x] Next.js App Router and Pages Router
- [x] GraphQL schemas (SDL)
- [x] OpenAPI 3, Postman and Insomnia exporters
- [x] `routier.json` configuration
- [x] Auth, headers, query params and Zod body inference
- [x] Express, Fastify and NestJS
- [ ] TypeBox, Joi and Yup schemas
- [ ] Response schemas
- [ ] GitHub Action that keeps collections up to date and reports API changes in pull requests

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup and guidelines.

## License

[ISC](./LICENSE) © Matias Arenas (FHX23)

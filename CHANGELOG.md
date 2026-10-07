# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## 0.3.0 - Unreleased

This release was driven by testing Routier against nine real projects (three private Next.js applications and six public Express, Fastify, NestJS and Next.js repositories), comparing its output with endpoint lists written by hand and sending every generated request to the running applications with Newman (Postman) and Insomnia's importer.

### Added

- **Request bodies without a validation library**: bodies are inferred from TypeScript types (`as T`, `: T`, `let x: T`), destructuring (with defaults), the fields a handler reads, and by following the body into server actions and services two levels deep.
- **Cookie sessions**: next-auth v4/v5, better-auth, Clerk, Supabase, Lucia, iron-session and `req.session`, including helper functions, Next.js `middleware.ts`/`proxy.ts` (with its matcher and public paths) and Fastify autohooks. They are documented as OpenAPI cookie security schemes and sent as a `Cookie` header with a `session` variable in Postman and Insomnia.
- **Joi and TypeBox** schemas, validator middlewares (`validate({ body, query })`) and schemas imported through `require`, `module.exports` and re-exports.
- **Uploads**: `multipart/form-data` bodies from `formData()`, multer, `@fastify/multipart` and NestJS `FileInterceptor`; `text/plain` bodies from `req.text()`.
- Express: chained anonymous routers (`Router().use(a).use(b)`, `export default Router().use('/api', api)`), mounts declared in arrays walked with `forEach`, and optional auth (`auth.optional`).
- NestJS: global prefix from configuration defaults and `exclude` lists, auth from `consumer.apply(AuthMiddleware).forRoutes(...)`, and `@Query()`/`@Body()` objects followed into injected services.
- Query parameters read by services (`getArticles(req.query)` → `query.tag`).
- GraphQL: GET endpoints, the endpoint's authentication on every operation, and realistic values for custom scalars (`DateTime`, `JSON`, `UUID`...).
- TypeScript utility types (`Partial`, `Omit`, `Pick`, `Required`), inline object types, `z.infer<typeof schema>`, Prisma 7 enums and literal-union casts.
- **Allow-lists checked in code become enums**: `if (!PLANS.includes(plan))`, `!ALLOWED.has(body.kind)`, `!['a', 'b'].includes(x)`, `!(x in PRICES)` and `Object.keys(PRICES).includes(x)`, with the list declared locally or imported.
- **Required query parameters**: query schemas from Joi, Zod, TypeBox, JSON Schema and NestJS `@Query()` DTOs keep their types and required fields. Required parameters are documented as `required` in OpenAPI and exported enabled, with a valid example value, in Postman and Insomnia.
- class-validator constraints (`@Min`, `@Max`, `@IsPositive`, `@MinLength`, `@MaxLength`, `@Length`, `@Matches`, `@ArrayMinSize`) are applied to DTO schemas and examples.

### Changed

- **Example values respect the validations**: string lengths, numeric limits, formats, enums, defaults and simple regular expressions (Chilean RUT, phone numbers, password rules). Optional references (`clientId`) and `z.date()` fields are left out of examples, and end-of-range dates come after start dates.
- Optional query parameters are exported **disabled** in Postman and Insomnia instead of being sent empty.
- Setup middlewares such as `passport.initialize()` or rate limiters are no longer treated as authentication.
- When several files declare the same route (alternative controllers), the first declaration wins.
- The raw GraphQL endpoint request carries a minimal valid query.

### Fixed

- Only schemas that validate the body define it (`routeContextSchema.parse(context)` is not a body).
- Zod schemas written with named imports (`import { object, string } from 'zod'`).
- Mutually recursive helpers and self-referencing schemas no longer stall the scan.
- A named schema reached first through a deep path could be cached with empty fields.
- Fields spread from the body (`{ ...req.body.user }`) are recognised.

## 0.2.0 - 2026-09-26

### Added

- **Express, Fastify and NestJS support**, with the framework detected automatically from `package.json` (`--framework auto`).
  - Express: nested `app.use('/prefix', router)` mounts across ESM and CommonJS files, `router.route()` chains, auth and validator middlewares.
  - Fastify: plugin prefixes (imported, inline and `@fastify/autoload`), `route({...})`, JSON Schema bodies and querystrings, auth hooks.
  - NestJS: global prefix, URI versioning, guards and `@Public()`, `@Body`/`@Query`/`@Headers`, class-validator DTOs and Zod pipes.
- **Library API**: `import { scanProject, generateOpenAPI, ... } from 'routier'`, with TypeScript declarations.
- `routier.json` configuration file with an interactive setup wizard.
- OpenAPI 3.0.3 output (`--format openapi`), used as the single source for the Postman and Insomnia exporters.
- Inference of auth headers, custom headers, query parameters and request bodies (Zod 3/4, JSON Schema, DTOs), including schemas imported from other files and the `@/` alias.
- GraphQL: `extend type`, custom root types (`schema { query: RootQuery }`), and sample variables for enums and input objects.
- `routier scan --json`, `--no-interactive`, `--exclude` and validation of every option and `routier.json` value.

### Changed

- The CLI and the README are now in English; a Spanish README is available in `README.es.md`.
- Authorization is documented as an OpenAPI `bearerAuth` security scheme, and GraphQL operations are examples of the real endpoint instead of fake paths.
- Collections define `token` and header variables, and include query and path parameters.
- Node.js 22.12 or newer is required.

### Fixed

- Next.js handlers with a destructured context (`GET(req, { params })`) are now analysed.
- Comments are removed without breaking strings that contain `//` (such as URLs).
- The `Authorization` header is only added to the handlers that actually read it, and `GET` requests never get a body.
- Routes inside monorepo workspaces (`apps/web/app/...`) keep their real path; private folders and intercepted routes are ignored.
- `z.array(z.object({...}))` produces an array example.
- Insomnia header variables are valid template identifiers.
- The GraphQL endpoint path is taken from the project instead of being hard-coded to `/api/graphql`.
- Importing the package no longer runs the CLI.

## 0.1.0 – 0.1.2 - 2026-06-18

- First public releases: Next.js App Router and Pages Router scanning, GraphQL SDL operations, and Postman / Insomnia exporters.


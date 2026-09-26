# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## 0.2.0 - Unreleased

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


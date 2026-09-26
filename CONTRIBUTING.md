# Contributing to Routier

Thanks for your interest in improving Routier! Bug reports, new framework patterns and fixes are all welcome.

## Development setup

Requirements: Node.js 22.12 or newer and [pnpm](https://pnpm.io) (the version is pinned in `package.json`; `corepack enable` will pick it up).

```bash
git clone https://github.com/FHX23/Routier.git
cd Routier
pnpm install
pnpm test
```

Useful scripts:

| Script | What it does |
| --- | --- |
| `pnpm test` | Runs the test suite (`node:test` + `tsx`) |
| `pnpm run typecheck` | Type-checks the sources without emitting |
| `pnpm run build` | Compiles `src/` to `dist/` |
| `pnpm run dev -- scan --cwd tests/fixtures/next-app` | Runs the CLI from source |

To try the CLI in another project, run `pnpm run build` and then `npm link` in this folder; `routier` will then be available globally.

## Project layout

```
src/
  cli.ts                 # CLI entry point (bin)
  index.ts               # Public library API
  scanner.ts             # Picks the framework adapters and merges results
  parsers/
    shared/              # Lexical helpers, Zod and request inference used by every adapter
    next/ express/ fastify/ nestjs/ graphql/
  generators/openapi.ts  # ScanResult -> OpenAPI (the source of truth)
  exporters/             # OpenAPI -> Postman / Insomnia
tests/
  fixtures/              # Small sample projects used by the tests
```

The pipeline is always `source code -> adapter -> ScanResult -> OpenAPI -> Postman/Insomnia`, so a new framework only needs a parser that returns `Endpoint[]`.

## Adding support for a new pattern

1. Add the smallest possible example to a fixture under `tests/fixtures/` (or create a new fixture project).
2. Write a failing test that describes the expected endpoint, headers or body.
3. Implement it, reusing the helpers in `src/parsers/shared/` where possible.

Routier never executes user code: everything is static analysis, so prefer patterns that can be recognised reliably over clever guesses.

## Pull requests

- Keep PRs focused; one feature or fix per PR.
- Make sure `pnpm test` and `pnpm run typecheck` pass (CI runs them on Linux and Windows).
- Update `README.md`, `README.es.md` and `CHANGELOG.md` when users will notice the change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`...).

## Releases

Releases are published to npm from GitHub Actions when a GitHub Release `vX.Y.Z` is created. The tag must match the `version` in `package.json`.

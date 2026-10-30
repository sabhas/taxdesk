# TaxDesk

TaxDesk is a single-firm tax practice workspace. This repository is a pnpm
workspace modular monolith containing the React/Vite web app, Hono Worker API,
shared Zod contracts, database package, and test utilities.

## Requirements

- Node.js 22+
- pnpm 10+

## Commands

| Task                                                 | Command             |
| ---------------------------------------------------- | ------------------- |
| Install dependencies                                 | `pnpm install`      |
| Type check every package                             | `pnpm typecheck`    |
| Lint every package (includes import-boundary checks) | `pnpm lint`         |
| Check formatting                                     | `pnpm format:check` |
| Apply formatting                                     | `pnpm format`       |
| Run all tests                                        | `pnpm test`         |
| Build every package                                  | `pnpm build`        |
| Run the full quality gate                            | `pnpm verify`       |

`pnpm verify` runs type check, lint, format check, tests, and build in order. CI
should run the same command after `pnpm install --frozen-lockfile`.

## Workspace layout

```text
packages/
  api/         Hono Worker API (domain services, routes, request-ID middleware,
               wrangler.toml environment bindings)
  database/    Drizzle/PostgreSQL client, forward-only migration runner, and
               migrations/ SQL files
  shared/      Shared Zod contracts and public DTOs
  test-utils/  Shared test helpers
  web/         React/Vite web application (wrangler.toml Pages config)
```

## Environments

`development`, `staging`, and `production` each use a separate managed
PostgreSQL database, Hyperdrive binding, Worker/Pages project, and secret set.
See [`docs/technical/environments.md`](docs/technical/environments.md) for the
environment matrix, deployment commands, and health verification.

| Task                                       | Command                      |
| ------------------------------------------ | ---------------------------- |
| Run the API locally                        | `pnpm dev:api`               |
| Run the web app locally                    | `pnpm dev:web`               |
| Deploy the API to staging                  | `pnpm deploy:api:staging`    |
| Deploy the API to production               | `pnpm deploy:api:production` |
| Build and deploy the web app to staging    | `pnpm deploy:web:staging`    |
| Build and deploy the web app to production | `pnpm deploy:web:production` |

Deployment commands use `pnpm dlx wrangler` and require Cloudflare
credentials plus the Hyperdrive IDs configured in `packages/api/wrangler.toml`.

## Database migrations

Migrations are forward-only and checksummed against
[`packages/database/migrations/manifest.json`](packages/database/migrations/manifest.json).
Apply them to the target database before deploying the API. See
[`docs/technical/migrations.md`](docs/technical/migrations.md) for the full
runbook, including clean-database setup and rollback policy.

| Task                                                                        | Command                    |
| --------------------------------------------------------------------------- | -------------------------- |
| Apply pending migrations to `DATABASE_URL`                                  | `pnpm db:migrate`          |
| Show applied/pending migrations (`--check` fails on pending)                | `pnpm db:migrate:status`   |
| Verify files against the committed checksum manifest (no database, CI gate) | `pnpm db:migrate:verify`   |
| Record new migrations in the manifest (never rewrites history)              | `pnpm db:migrate:manifest` |
| Run the PostgreSQL migration integration suite                              | `pnpm test:migrations`     |

The last command requires `TAXDESK_MIGRATIONS_TEST_DATABASE_URL` pointing at a
disposable database whose name ends in `_test`; without it the integration tests
are skipped and `pnpm test` still runs the unit suite.

`pnpm db:migrate` and `pnpm db:migrate:status` read `DATABASE_URL` from the
repo-root `.env` or `.env.local` (both git-ignored). An explicit shell value or a
`--database-url` argument takes precedence, which is how CI and staging pass the
secret. Add the variable to `.env` as shown in `.env.example`.

## API and web smoke test

The web dev server proxies `/api` requests to `http://localhost:8787`. The API
exposes `GET /health` for environment, release version, and request ID only, and
`GET /api/v1/app-info` as a durable smoke-test endpoint; real product endpoints
are added story by story.

## Quality baseline

- Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  and `verbatimModuleSyntax`.
- ESLint with `typescript-eslint` strict/stylistic rules and `eslint-plugin-boundaries`
  to keep the shared, database, API, web, and test-utils layers separated.
- Prettier formatting for code and configuration files.
- Vitest unit tests in every package, React Testing Library browser-like tests in
  the web package, and an axe accessibility check for the web shell.

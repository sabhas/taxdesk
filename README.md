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
  database/    Drizzle/PostgreSQL client and schema placeholder
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

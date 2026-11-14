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

`pnpm verify` runs type check, lint, format check, tests, migration checksum
validation, secret scanning, workflow-policy enforcement, the gate self-test,
and build in order. CI runs the same gates after
`pnpm install --frozen-lockfile`.

## Dependency reset

The optional [`just`](https://github.com/casey/just) recipes wrap the safe
reinstall paths. Install it with `brew install just`, then run `just` from the
repo root to list recipes.

| Task                                                           | Command                |
| -------------------------------------------------------------- | ---------------------- |
| Install from the committed lockfile                            | `just install`         |
| Remove `node_modules` and reinstall                            | `just reinstall`       |
| Reinstall including optional native packages for all platforms | `just reinstall-force` |
| Intentionally regenerate `pnpm-lock.yaml`                      | `just relock`          |
| Run the complete quality gate                                  | `just verify`          |
| Show platform and installed Rollup binaries                    | `just doctor`          |

`pnpm-lock.yaml` is versioned and should not be deleted for routine
troubleshooting. `just reinstall` removes only generated `node_modules`
directories; `just relock` is for deliberate dependency changes and its result
must be reviewed and committed. Without `just`, run the equivalent commands
directly:

```bash
rm -rf node_modules packages/*/node_modules
pnpm install --frozen-lockfile
```

Use `pnpm install --frozen-lockfile --force` only when a shared workspace's
native optional dependency is missing because `node_modules` was last populated
on a different operating system or CPU architecture.

## Workspace layout

```text
packages/
  api/         Hono Worker API (domain services, routes, request-ID middleware,
               wrangler.toml environment bindings)
  database/    Drizzle/PostgreSQL client, forward-only migration runner, and
               migrations/ SQL files
  onedrive-spike/  TD-005 throwaway feasibility harness and its report CLI
               (not deployed and not imported by the product)
  platform/    TD-006 CI gates, staging smoke checks, database posture,
               secret scanning, and recovery-evidence validation
  shared/      Shared Zod contracts and public DTOs
  test-utils/  Shared test helpers
  web/         React/Vite web application, Pages Function API proxy, and
               wrangler.toml Pages/service-binding config
```

The web UI uses shadcn/ui components on Base UI with Tailwind CSS and shared
design tokens. See `docs/technical/design-system.md` before adding UI.

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

Deployment commands use the workspace-pinned `wrangler` binary (`pnpm exec
wrangler`) so a release is never built by an unpinned download. They require
Cloudflare credentials plus the Hyperdrive IDs configured in
`packages/api/wrangler.toml`.
The web deploy commands include the Pages Function in `packages/web/functions/`
and use the `staging` preview branch and `main` production branch so each Pages
project receives its matching API service binding.

Routine staging deploys are automated: a successful `CI` run on a `main` push
applies migrations, verifies database and recovery posture, deploys the API and
web app, and smoke-tests the Pages host. Pull-request builds run with read-only
permissions and no repository or environment secrets. See
[`docs/technical/ci.md`](docs/technical/ci.md) for the workflows, required
branch-protection checks, environment secrets, and recovery evidence contract.

| Task                                       | Command                 |
| ------------------------------------------ | ----------------------- |
| Scan tracked files for secrets             | `pnpm ci:secrets`       |
| Enforce the CI/deployment workflow policy  | `pnpm ci:workflows`     |
| Prove failing gates are rejected           | `pnpm ci:selftest`      |
| Verify staging TLS and database role       | `pnpm ci:db-posture`    |
| Validate recovery/export/alerting evidence | `pnpm ci:backup-check`  |
| Check the latest independent export        | `pnpm ci:backup-verify` |
| Smoke-test a deployed staging host         | `pnpm ci:staging-smoke` |

## Data import, backup, and recovery (Epic 7)

Administrators import existing clients, active cases, and opening balances
from versioned CSV templates in **Data import**; see
[`docs/guides/data-import.md`](docs/guides/data-import.md). Backups and
restores follow [`docs/guides/backup-and-restore.md`](docs/guides/backup-and-restore.md),
and the migration rehearsal follows
[`docs/guides/migration-rehearsal.md`](docs/guides/migration-rehearsal.md).

| Task                                                         | Command                      |
| ------------------------------------------------------------ | ---------------------------- |
| Encrypted `pg_dump` export of `DATABASE_URL` with a manifest | `pnpm ops:backup-export`     |
| Decrypt an export for `pg_restore`                           | `pnpm ops:backup-decrypt`    |
| Record counts, money totals, and integrity of a database     | `pnpm ops:recovery-snapshot` |
| Verify a restored database against the source and the RTO    | `pnpm ops:restore-verify`    |
| Generate synthetic, production-shaped import files           | `pnpm ops:sample-import`     |

Each command prints `--help` usage and one JSON report line; none prints a
connection string, key, or record content.

## OneDrive Personal feasibility spike

TD-005 is a throwaway harness, not a product feature. It proves that the
intended Microsoft Personal account can support the document workflow and
writes a strict, secret-free evidence record. It is not deployed and is not
imported by the API or the web application.

| Task                            | Command                                            |
| ------------------------------- | -------------------------------------------------- |
| Run the OneDrive Personal spike | `pnpm spike:onedrive --client-id <application-id>` |

See [`docs/guides/onedrive-spike.md`](docs/guides/onedrive-spike.md) for the app
registration, the exact delegated scopes, the revocation step, and the evidence
recording. The recorded outcome lives in
[`docs/product/sprint-1-review-notes.md`](docs/product/sprint-1-review-notes.md).

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

## API and web walking skeleton

The web dev server proxies `/health` and `/api` requests to
`http://localhost:8787`. In Cloudflare Pages, the Function in
`packages/web/functions/[[path]].ts` forwards the same paths to the staged Hono
Worker through the `API` service binding, so the browser always uses same-origin
requests.

The API exposes `GET /health` for environment, release version, and request ID
only, and `GET /api/v1/app-info` as a durable smoke-test endpoint; real product
endpoints are added story by story. The React shell calls `/health`, shows
loading and success states, and presents a friendly retryable error with the
request reference ID when the health call fails.

## Identity and access

Epic 1 adds custom staff accounts (username and password) with mandatory TOTP MFA. There is no public
registration: the first administrator is created offline, and everyone else is
invited by an administrator with a one-time 30-minute link that TaxDesk shows
but never emails.

| Task                                                               | Command               |
| ------------------------------------------------------------------ | --------------------- |
| Create the firm and first administrator (refuses a second run)     | `pnpm auth:bootstrap` |
| Offline lockout recovery (reset password, disable MFA, reactivate) | `pnpm auth:recover`   |
| Run the identity repository integration suite                      | `pnpm test:api-db`    |

Both CLIs need deployment-level `DATABASE_URL` access and write audit events;
see [`docs/guides/administrator-recovery.md`](docs/guides/administrator-recovery.md).
`pnpm test:api-db` needs `TAXDESK_API_TEST_DATABASE_URL` (or
`TAXDESK_MIGRATIONS_TEST_DATABASE_URL`) pointing at a disposable `_test`
database and is skipped otherwise.

Every `/api/v1` route declares one access policy with `protect()` in
`packages/api/src/middleware/auth.ts` (`public`, `session`, `self_service`,
`permission`, or `self_or_permission`). A route-registry test fails if a route
has no policy and drives every built-in role against every declared
permission. The role/permission catalog lives in `@taxdesk/shared`
(`ROLE_DEFINITIONS`). The decisions are recorded in
[ADR 0001](docs/adr/0001-custom-identity-sessions-and-mfa.md); identity secrets
are listed in [`docs/technical/environments.md`](docs/technical/environments.md).

## API error contract

Every API failure returns RFC 9457-style Problem Details with the
`application/problem+json` content type:

```json
{
  "type": "https://taxdesk.app/problems/not-found",
  "title": "Not Found",
  "status": 404,
  "code": "NOT_FOUND",
  "detail": "The requested resource was not found.",
  "requestId": "0f2c…"
}
```

`ProblemDetailsSchema` and `RequestIdSchema` live in `@taxdesk/shared`;
`errors` is an optional array of `{ field, message }` validation entries. The
API's request-ID middleware keeps a bounded, header-safe inbound `X-Request-Id`
or generates a UUID, echoes it on every response, and never places secrets,
provider tokens, database details, or raw errors in the body or structured log.

## Quality baseline

- Strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  and `verbatimModuleSyntax`.
- ESLint with `typescript-eslint` strict/stylistic rules and `eslint-plugin-boundaries`
  to keep the shared, database, API, web, and test-utils layers separated.
- Prettier formatting for code and configuration files.
- Vitest unit tests in every package, React Testing Library browser-like tests in
  the web package, and an axe accessibility check for the web shell.

---
title: Environments and deployment
status: accepted
version: 1.0
owners: [engineering, operations]
last_reviewed: 2026-11-04
related:
  - architecture.md
  - migrations.md
  - ci.md
  - ../product/prd/epic-00-foundation-and-platform.md
---

# Environments and deployment

TaxDesk runs one isolated stack per firm. This runbook covers the
`development`, `staging`, and `production` environments required by TD-002.
Each environment owns a separate managed PostgreSQL database, Hyperdrive
binding, Worker/Pages project, and secret set. Nothing is shared between them.

## Environment matrix

| Concern | development | staging | production |
| --- | --- | --- | --- |
| Purpose | Contributor workstation, synthetic data only | Pre-production verification, synthetic data only | Live firm data |
| Worker name | `taxdesk-api` (local `wrangler dev`) | `taxdesk-api-staging` | `taxdesk-api-production` |
| Worker config | `packages/api/wrangler.toml` (`[vars]`) | `[env.staging]` | `[env.production]` |
| Pages project | local Vite dev server | `taxdesk-web-staging` | `taxdesk-web-production` |
| Managed PostgreSQL | dedicated development database | dedicated staging database | dedicated production database |
| Hyperdrive binding | `HYPERDRIVE` (development ID) | `HYPERDRIVE` (staging ID) | `HYPERDRIVE` (production ID) |
| Secrets | local `.dev.vars` (git-ignored) | `wrangler secret put --env staging` | `wrangler secret put --env production` |
| `ENVIRONMENT` | `development` | `staging` | `production` |

`ENVIRONMENT` and `RELEASE_VERSION` are public deployment metadata and are set
in `[vars]`. They are the only configuration the health endpoint reads.

## Isolation rules

- Databases, Hyperdrive configurations, Worker/Pages projects, and secret sets
  are created separately for each environment. Never point one environment at
  another environment's database or secret.
- Only `development` and `staging` may contain synthetic data. Real client data
  appears in `production` only after the TD-709 restore rehearsal and TD-710
  security review pass.
- Pull-request and preview builds must not have access to production secrets. The workflow policy gate in `pnpm ci:workflows` rejects a `pull_request` workflow that enters an environment or references `secrets.*`; see [ci.md](ci.md).
- Replace every `REPLACE_WITH_*_HYPERDRIVE_ID` placeholder before deploying.

## Managed PostgreSQL and Hyperdrive over TLS

1. Provision a managed PostgreSQL database per environment with automated
   encrypted backups and point-in-time recovery enabled.
2. Create a least-privilege application role per database. It does not own the
   schema and does not have superuser or `CREATEDB`/`CREATEROLE` rights.
3. Create a Hyperdrive configuration per environment:

   ```bash
   pnpm exec wrangler hyperdrive create taxdesk-development \
     --connection-string="postgres://<app-role>:<password>@<host>:5432/<database>?sslmode=require"
   ```

   Repeat with `taxdesk-staging` and `taxdesk-production`. Copy the returned
   Hyperdrive ID into the matching binding in `packages/api/wrangler.toml`.

4. The application enforces the TLS requirement in code. `createDatabaseClient`
   calls `postgres(connectionString, { prepare: false, ssl: 'require' })`, so a
   non-TLS connection is rejected even if the connection string omits a mode.
   Hyperdrive pools Worker connections and exposes only the connection string
   through the binding; the credential never enters source control or logs.

### Local development

`wrangler dev` emulates Hyperdrive locally and therefore needs a local
connection string, not just the Hyperdrive `id`. The development binding in
`packages/api/wrangler.toml` sets a non-secret default:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "REPLACE_WITH_DEVELOPMENT_HYPERDRIVE_ID"
localConnectionString = "postgres://taxdesk:taxdesk@localhost:5432/taxdesk_development"
```

Start a local Postgres and create `taxdesk_development`, or point at the
managed development database by overriding the value. The environment variable
takes precedence over `localConnectionString`, so no file edit is needed.
Choose one of these:

**Root `.env` file (recommended).** Wrangler auto-loads `.env` from the
directory it is run in, which is the repo root for `pnpm dev:api`:

```dotenv
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://<app-role>:<password>@<dev-host>:5432/<dev-database>?sslmode=require
```

Copy `.env.example` to `.env`; `.env` is git-ignored. `.env.local` is also
loaded and takes precedence over `.env`.

**Per-command shell variable:**

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://<app-role>:<password>@<dev-host>:5432/<dev-database>?sslmode=require" \
  pnpm dev:api
```

The health endpoint does not touch the database, so `wrangler dev` starts even
if no local Postgres is running; a database-backed request fails until one is.
`localConnectionString` is ignored during `wrangler deploy`, and staging and
production bindings do not set it. Never commit the real connection string.

Create the development database and apply the forward-only migrations before
database-backed requests work:

```bash
createdb taxdesk_development                       # or provision the managed development database
pnpm db:migrate                                    # uses DATABASE_URL / .env
pnpm db:migrate:status
```

See [`migrations.md`](migrations.md) for clean-database setup, checksum
verification, add-a-migration steps, and the rollback policy.

## Secret sets

Secrets are managed per environment with `wrangler secret put`; they are never
committed and never returned by an API. At this story there are no application
secrets yet (database access is supplied by the Hyperdrive binding). Future
provider credentials such as OneDrive/Graph values are added here.

The TD-005 OneDrive feasibility spike deliberately adds **no** Worker secret. It
runs on an operator workstation as a local CLI, is a public client using
PKCE (so it has no client secret), and holds tokens in memory only. Its
configuration comes from CLI flags and these local, non-secret variables:

| Variable | Purpose |
| --- | --- |
| `TAXDESK_MS_GRAPH_CLIENT_ID` | Application (client) ID of the non-production spike registration |
| `TAXDESK_SPIKE_OPERATOR` | Name recorded in the committed evidence file |

See [`../guides/onedrive-spike.md`](../guides/onedrive-spike.md). Do not put a
Graph client secret, refresh token, or access token in `.dev.vars`, `.env`, or a
Worker secret for the spike.

```bash
pnpm exec wrangler secret list --env staging
pnpm exec wrangler secret put <SECRET_NAME> --env staging
```

For local development, copy `packages/api/.dev.vars.example` to
`packages/api/.dev.vars` (git-ignored) and use only non-confidential test
values.

## Deployment

### Automated staging deployment

A successful `CI` run on a `main` push deploys staging automatically through
`.github/workflows/deploy-staging.yml`. The workflow applies migrations, verifies
database and recovery posture, deploys the API Worker and Pages app, then runs a
same-origin smoke check. It runs in the protected `staging` GitHub environment,
never for a pull request, and checks out the exact commit SHA that passed CI.

A manual dispatch must supply a full 40-character commit SHA; a branch name is
rejected. See [`ci.md`](ci.md) for the required environment secrets and
variables, the posture evidence contract, and the rollback procedure.

### API Worker

```bash
# Local development against the development Hyperdrive/database.
pnpm exec wrangler dev --config packages/api/wrangler.toml

# Staging then production. Apply migrations before each deploy (see
# migrations.md) and confirm the target is current.
DATABASE_URL="postgres://<app-role>:<password>@<host>:5432/<database>?sslmode=require" \
  pnpm db:migrate
DATABASE_URL="postgres://<app-role>:<password>@<host>:5432/<database>?sslmode=require" \
  pnpm db:migrate:status --check

pnpm exec wrangler deploy --config packages/api/wrangler.toml --env staging
pnpm exec wrangler deploy --config packages/api/wrangler.toml --env production
```

Set `RELEASE_VERSION` in the matching `wrangler.toml` environment before a
manual deploy so the health endpoint reports the released build. The automated
staging workflow overrides it with the deployed commit
(`pnpm deploy:api:staging --var RELEASE_VERSION:$DEPLOY_SHA`), so the running
staging health response always identifies the verified commit.

### Web application (Cloudflare Pages)

The Pages Function at `packages/web/functions/[[path]].ts` proxies same-origin
`/health` and `/api/*` requests to the Hono Worker bound as `API`.
`packages/web/public/_routes.json` limits Function invocation to those paths, so
static application routes are still served directly by Pages. The browser never
connects to PostgreSQL or a storage provider directly.

`packages/web/wrangler.toml` declares the service binding per deployment target:

| Pages target | Branch | `API` service binding |
| --- | --- | --- |
| Local/development | local | `taxdesk-api` |
| Staging | `staging` preview | `taxdesk-api-staging` |
| Production | `main` production | `taxdesk-api-production` |

Deploy the two web environments with the repository commands:

```bash
# Build, include functions/, and deploy the staging preview binding.
pnpm deploy:web:staging

# Build, include functions/, and deploy the production binding.
pnpm deploy:web:production
```

The commands run `wrangler` with `--cwd packages/web` so Pages finds the
`functions/` directory and the service-binding configuration. If a Pages project
uses a different production branch, pass its branch to `wrangler pages deploy`;
the binding must still point at the matching Worker.

Verify the deployed walking skeleton from the Pages host:

```bash
curl -fsS https://<pages-host>/health | jq -e \
  '.environment == "staging" and (.requestId | length > 0)'
curl -fsS https://<pages-host>/api/v1/app-info | jq -e '.name == "TaxDesk API"'
```

Both requests must return the Worker response without a cross-origin browser
request. A missing or misconfigured `API` binding returns a safe `503` Problem
Details response instead of falling through to a static 404.

## Health contract

`GET /health` returns `200` with exactly three fields and a `Cache-Control:
no-store` header:

```json
{
  "environment": "staging",
  "releaseVersion": "1.2.3",
  "requestId": "0f2c…"
}
```

`X-Request-Id` keeps a bounded, header-safe inbound value or generates a UUID,
and always matches the `requestId` in the body.

## Problem Details and request IDs

API failures use the shared `ProblemDetailsSchema` from `@taxdesk/shared` and
return `Content-Type: application/problem+json`. The body contains `type`,
`title`, `status`, `code`, `detail`, `requestId`, and optional field `errors`.
The contract is strict, so database names, infrastructure addresses, provider
tokens, and raw exception messages cannot be added accidentally. Unhandled
errors are logged as structured JSON containing only the event name, request ID,
and error class; raw errors and secrets are never serialized.

### Verify on staging and production

```bash
# 1. The payload contains the expected environment and version.
curl -fsS https://<api-host>/health | jq -e \
  '.environment == "staging" and (.releaseVersion | length > 0) and (.requestId | length > 0)'

# 2. The payload exposes the three allowed keys and nothing else.
curl -fsS https://<api-host>/health | jq -e \
  '(keys | sort) == ["environment","releaseVersion","requestId"]'

# 3. No secrets, database names, connection details, or infrastructure hosts.
curl -fsS https://<api-host>/health | grep -Eiv \
  'password|secret|postgres|taxdesk_(development|staging|production)|internal|\.example|\.internal'
```

The same assertions run in the automated suite:
`packages/api/src/index.test.ts` asserts the exact key set and that a payload
built from bindings containing a database URL, a Hyperdrive connection string,
and a client secret never appears in the response, while
`packages/shared/src/health.test.ts` rejects unknown fields.

## Recovery and backup posture

Staging must have automated encrypted backups, point-in-time recovery, an
independent encrypted export stored outside the database provider, and an
operator alert on failed recovery checks. `pnpm ci:db-posture` verifies the live
TLS session and least-privilege database role; `pnpm ci:backup-check` validates
the operator-recorded coverage and export evidence. The daily `Platform posture`
workflow re-runs the check and opens an operator issue when it fails. The
evidence contract and runbook live in [`ci.md`](ci.md).

Do not deploy staging while the posture gate fails. Real client data remains
forbidden in staging; the production recovery rehearsal is TD-709.

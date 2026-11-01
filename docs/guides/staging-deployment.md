---
title: First-time staging deployment guide
status: accepted
version: 1.0
owners: [engineering, operations]
last_reviewed: 2026-11-04
related:
  - ../technical/environments.md
  - ../technical/migrations.md
  - ../product/prd/epic-00-foundation-and-platform.md
---

# First-time staging deployment guide

This guide walks through the first deployment of the TaxDesk walking skeleton to
staging. It assumes no prior Wrangler or Cloudflare experience and covers only
the staging environment. Do not create production resources as part of TD-004.

> **Routine deployments are automated.** TD-006 deploys a successful `main`
> build to staging and verifies migrations, database posture, recovery evidence,
> and a same-origin smoke check. Use this guide only to provision the staging
> resources for the first time or to recover a misconfigured environment. See
> [`../technical/ci.md`](../technical/ci.md) for the pipeline, required GitHub
> environment secrets, and the posture evidence contract.

You will create:

- A staging PostgreSQL database.
- A Cloudflare Hyperdrive configuration for that database.
- The `taxdesk-api-staging` Worker.
- The `taxdesk-web-staging` Pages project.
- A Pages → Worker service binding so `/health` and `/api/*` work same-origin.

## Step 1 — Install and verify the tools

From the repository root:

```bash
cd <path-to-your-taxdesk-clone>

node --version      # must be 22+
pnpm --version      # must be 10+

pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` must pass before deploying.

## Step 2 — Log in to Cloudflare

```bash
pnpm exec wrangler login
```

This opens a browser. Approve access, then confirm:

```bash
pnpm exec wrangler whoami
```

You should see your Cloudflare account email and account ID.

If you use an API token instead of browser login:

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
```

Do not commit those values.

## Step 3 — Create the staging PostgreSQL database

Use a **separate staging database** from development and production.

You need a TLS connection string that looks like:

```text
postgres://USER:PASSWORD@HOST:5432/taxdesk_staging?sslmode=require
```

Test it first:

```bash
psql "postgres://USER:PASSWORD@HOST:5432/taxdesk_staging?sslmode=require" \
  -c "select current_database(), current_user;"
```

If your provider requires special characters in the password, URL-encode them in
the connection string.

The database role needs permission to create tables because the migration ledger
is created at runtime. If a migration fails with `permission denied for schema
public`, grant the role the required schema permissions or use the database owner
role for the first migration.

Never commit this connection string.

## Step 4 — Create the Hyperdrive configuration

Cloudflare Hyperdrive stores the database connection string and gives the Worker
a secure binding.

Run:

```bash
pnpm exec wrangler hyperdrive create taxdesk-staging \
  --connection-string="postgres://USER:PASSWORD@HOST:5432/taxdesk_staging?sslmode=require"
```

Wrangler prints something like:

```text
id: 0123456789abcdef...
```

Copy that ID.

Open `packages/api/wrangler.toml` and find:

```toml
[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "REPLACE_WITH_STAGING_HYPERDRIVE_ID"
```

Replace the placeholder:

```toml
[[env.staging.hyperdrive]]
binding = "HYPERDRIVE"
id = "YOUR_STAGING_HYPERDRIVE_ID"
```

Also set a meaningful release version:

```toml
[env.staging.vars]
ENVIRONMENT = "staging"
RELEASE_VERSION = "0.1.0-td004"
```

Confirm the Hyperdrive configuration exists:

```bash
pnpm exec wrangler hyperdrive list
```

## Step 5 — Apply staging database migrations

Set the staging database URL for the current shell. Be careful: this may appear in
shell history.

```bash
export STAGING_DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/taxdesk_staging?sslmode=require"
```

Verify the committed migration files:

```bash
pnpm db:migrate:verify
```

Apply migrations:

```bash
DATABASE_URL="$STAGING_DATABASE_URL" pnpm db:migrate
```

Confirm the staging database is current:

```bash
DATABASE_URL="$STAGING_DATABASE_URL" pnpm db:migrate:status --check
```

The `--check` command must succeed before deploying the API.

Clear the variable when finished:

```bash
unset STAGING_DATABASE_URL
```

## Step 6 — Deploy the staging API Worker

```bash
pnpm deploy:api:staging
```

This runs the equivalent of:

```bash
pnpm exec wrangler deploy \
  --config packages/api/wrangler.toml \
  --env staging
```

Wrangler prints a URL similar to:

```text
https://taxdesk-api-staging.YOUR-WORKERS-SUBDOMAIN.workers.dev
```

Test it:

```bash
curl -fsS https://taxdesk-api-staging.YOUR-WORKERS-SUBDOMAIN.workers.dev/health
```

Expected response:

```json
{
  "environment": "staging",
  "releaseVersion": "0.1.0-td004",
  "requestId": "..."
}
```

If that works, the API Worker and Hyperdrive configuration are deployed
correctly.

## Step 7 — Create the staging Pages project

If this is the first time, create the Pages project:

```bash
pnpm exec wrangler pages project create taxdesk-web-staging \
  --production-branch main
```

If it already exists, skip this step.

The repository intentionally deploys staging as a `staging` **preview branch**,
so the `[env.preview]` configuration binds it to:

```toml
service = "taxdesk-api-staging"
```

Keep `main` as the Pages project's production branch.

## Step 8 — Deploy the staging web app

```bash
pnpm deploy:web:staging
```

This builds the React app, includes the Pages Function, and deploys it.

Wrangler prints a preview URL similar to:

```text
https://staging.taxdesk-web-staging.pages.dev
```

Use that branch URL for staging.

Open it in a browser. You should see:

```text
TaxDesk
Service status
TaxDesk is connected to the staging environment.
```

## Step 9 — Verify same-origin routing

Set the staging web URL:

```bash
export STAGING_WEB="https://staging.taxdesk-web-staging.pages.dev"
```

Check health through Pages:

```bash
curl -i "$STAGING_WEB/health"
```

Check the API through Pages:

```bash
curl -i "$STAGING_WEB/api/v1/app-info"
```

Check the Problem Details error contract:

```bash
curl -i "$STAGING_WEB/api/v1/does-not-exist"
```

Check request-ID propagation:

```bash
curl -i -H 'X-Request-Id: staging-smoke-1' "$STAGING_WEB/health"
```

Expected results:

- `/health` returns `200` with `"environment": "staging"`.
- `/api/v1/app-info` returns `200`.
- The unknown route returns `404` with
  `Content-Type: application/problem+json`.
- `X-Request-Id` and the body `requestId` match.
- No database names, secrets, or infrastructure addresses appear.

Clear the variable afterward:

```bash
unset STAGING_WEB
```

## Step 10 — Check the Pages service binding

If `/health` returns `503` through the Pages URL but works on the Worker URL, the
service binding is missing or wrong.

Open Cloudflare Dashboard:

```text
Workers & Pages → taxdesk-web-staging → Settings → Functions → Preview
```

Confirm:

```text
API → taxdesk-api-staging
```

If it is missing, add it, then redeploy:

```bash
pnpm deploy:web:staging
```

## Step 11 — Watch API logs if something fails

For live Worker logs:

```bash
pnpm exec wrangler tail taxdesk-api-staging
```

Keep that terminal open while making requests through the staging Pages URL.

## Staging evidence to record

Capture these for the sprint review:

- Staging Pages URL.
- Staging Worker `/health` response.
- Pages `/health` response.
- Pages `/api/v1/app-info` response.
- The `application/problem+json` 404 response.
- Matching `X-Request-Id` header and body value.
- Screenshot of the staging web page showing `staging`.
- Confirmation that the `taxdesk-web-staging` preview binding uses
  `taxdesk-api-staging`.

Automated staging deployment, secret isolation, and backup/posture checks are
implemented in TD-006; see [`../technical/ci.md`](../technical/ci.md). Do not
deploy production yet. Production deployment and the production recovery
rehearsal belong to later epics.

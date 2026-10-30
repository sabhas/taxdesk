---
title: Database migrations
status: accepted
version: 1.0
owners: [engineering, operations]
last_reviewed: 2026-10-30
related:
  - environments.md
  - data-model.md
  - architecture.md
  - ../product/prd/epic-00-foundation-and-platform.md
---

# Database migrations

TaxDesk migrations are **forward-only**. A migration that has been applied is
immutable history: it can never be edited, reordered, or deleted. A mistake is
corrected by adding a new compensating migration, and a catastrophic failure is
recovered from the managed database's point-in-time backups. This document is the
runbook for adding, verifying, and applying migrations in every environment.

## Layout

```text
packages/database/
  migrations/
    0001_initial_baseline.sql   # versioned, forward-only SQL
    0002_<name>.sql
    manifest.json               # committed name → SHA-256 checksum pairs
  src/migrations/
    contracts.ts                # Zod contracts for the ledger, manifest, reports
    checksum.ts                 # normalized SHA-256 computation
    errors.ts                   # typed migration failures
    source.ts                   # discovery, naming, ordering, checksums
    manifest.ts                 # additive manifest planning and verification
    ledger.ts                   # ledger bootstrap, reads, and inserts
    runner.ts                   # plan/verify/apply domain service
    postgres-executor.ts        # TLS-required PostgreSQL port
    cli.ts                      # operator/CI entry point
```

The migration contracts live in `@taxdesk/database`, not `@taxdesk/shared`,
because migrations are an operator and CI concern that must never become a
browser or public API contract. The runner is exported as
`@taxdesk/database/migrations`; the root `@taxdesk/database` entry stays free of
Node-only `fs`/`crypto` code so it remains safe for the Worker client.

## Migration ledger

The runner bootstraps `taxdesk_migration_ledger` with an idempotent
`CREATE TABLE IF NOT EXISTS` on first use. The ledger is deliberately **not** a
versioned migration: it must exist before any migration can be recorded.

| Column | Meaning |
| --- | --- |
| `name` (primary key) | Migration file name, for example `0002_add_client_index.sql` |
| `checksum` | Lowercase SHA-256 of the applied file, constrained by a `CHECK` |
| `applied_at` | UTC timestamp of the apply |
| `duration_ms` | Apply duration, for operator diagnostics |
| `applied_by` | Database role that applied it, defaulting to `current_user` |

Each pending migration is applied inside its own transaction together with its
ledger row. If the SQL fails, both the schema change and the ledger row roll
back, so a re-run is safe and a half-applied migration can never be recorded.
A session-level advisory lock (`MIGRATION_ADVISORY_LOCK_KEY`) serializes
concurrent runners.

## Commands

All migrations require `DATABASE_URL` unless noted. The final stdout line of
every command is a JSON report validated by `MigrationReportSchema`.

| Command | Purpose |
| --- | --- |
| `pnpm db:migrate` | Apply every pending migration to `DATABASE_URL` |
| `pnpm db:migrate:status` | Show applied and pending migrations without writing; add `--check` to exit `1` when pending |
| `pnpm db:migrate:verify` | Validate files against the committed checksum manifest (no database required) |
| `pnpm db:migrate:manifest` | Add newly discovered migrations to `manifest.json`; never rewrites history |
| `pnpm test:migrations` | Run the PostgreSQL integration suite (requires `TAXDESK_MIGRATIONS_TEST_DATABASE_URL`) |

Exit codes are `0` success, `1` a failed check or apply, and `2` a usage error.
The CLI prints migration names, counts, and checksums only — never the
connection string, credentials, or SQL of a failed migration.

### Providing `DATABASE_URL`

`pnpm db:migrate` and `pnpm db:migrate:status` read `DATABASE_URL`. Provide it in
one of three ways, in increasing precedence:

1. **Repo-root `.env` or `.env.local`** (recommended for local work). Both files
   are git-ignored and loaded automatically; `.env.local` wins on duplicate
   keys. A `not found. Continuing without it.` notice is expected when neither
   file exists (for example in CI, where the URL comes from a secret).

   ```dotenv
   # .env
   DATABASE_URL=postgres://taxdesk:taxdesk@localhost:5432/taxdesk_development?sslmode=disable
   ```

2. **Shell environment**, which always wins over the files and is how CI and
   staging pass the secret:

   ```bash
   DATABASE_URL="postgres://<app-role>:<password>@<host>:5432/<database>?sslmode=require" \
     pnpm db:migrate
   ```

3. **`--database-url` flag**, which wins over everything else:

   ```bash
   pnpm db:migrate --database-url "postgres://…"
   ```

Never commit a real connection string, and never point a local `.env` at
staging or production.

## Adding a migration

1. Create `packages/database/migrations/NNNN_snake_case_name.sql`, where `NNNN` is
   the next zero-padded version. One logical change per file.
2. Run `pnpm db:migrate:manifest` and commit the updated `manifest.json`.
3. Run `pnpm db:migrate:verify` and `pnpm test` to confirm the manifest matches.
4. Apply with `pnpm db:migrate` against development, then staging, before the
   matching application deploy.

Do not rename an existing file, change its contents, or reuse a version prefix.

## Clean development database setup

The development database is dedicated and synthetic-data-only. To initialize a
clean database from scratch:

```bash
# Local PostgreSQL example. Managed development databases are created in the
# provider console with automated backups and a least-privilege role.
createdb taxdesk_development

# Add DATABASE_URL to the repo-root .env (see "Providing DATABASE_URL"), then:
pnpm db:migrate
pnpm db:migrate:status
```

`sslmode=disable` is the only explicit TLS opt-out and exists solely for a local,
throwaway database. Every other connection keeps TLS required, so staging and
production cannot silently downgrade. Never place real client data in
development or staging.

## Staging application and CI

Migrations are applied to the target database **before** the API and web
deployments run, in this order:

```bash
# 1. Apply forward-only migrations using the environment's secret.
DATABASE_URL="postgres://<app-role>:<password>@<host>:5432/<database>?sslmode=require" \
  pnpm db:migrate

# 2. Confirm the target is current before deploying the application.
DATABASE_URL="postgres://<app-role>:<password>@<host>:5432/<database>?sslmode=require" \
  pnpm db:migrate:status --check

# 3. Deploy the Worker and Pages application (see environments.md).
```

CI (wired in TD-006) runs `pnpm db:migrate:verify` — the checksum gate below —
and must hold the staging `DATABASE_URL` in an environment-scoped secret. Until
CI exists, the same check runs as part of `pnpm test` and can be invoked
directly.

## CI checksum protection

Two layers reject edited history:

1. **Committed manifest.** `package.json` pins each migration name to its
   SHA-256 checksum in `migrations/manifest.json`. `pnpm db:migrate:verify` and
   the `committed-migrations.test.ts` suite (part of `pnpm test`, which CI runs)
   fail with `MIGRATION_CHECKSUM_MISMATCH` when a recorded file changes, and with
   a `MIGRATION_HISTORY_*` error when a recorded file disappears.
2. **Applied ledger.** `pnpm db:migrate` compares each local file against the
   ledger row written when it was applied. Drift stops the run before any
   pending migration is applied.

`pnpm db:migrate:manifest` is additive only. It appends new migrations and
refuses to modify an existing entry, so the only way past a checksum failure is
a new compensating migration.

## Failed migrations and rollback

- **Failed apply.** The failing file's transaction rolls back, no ledger row is
  written, and the command exits `1`. Fix the cause with a *new* migration (or
  delete the broken file **only if it was never applied anywhere**, including
  staging), then re-run `pnpm db:migrate`.
- **Compensating forward migration.** The normal rollback path is a new
  migration that reverses the unwanted change, for example dropping a column or
  restoring a constraint.
- **Controlled restore.** When a migration has already corrupted data, recovery
  uses the managed database's point-in-time recovery to a point before the
  migration, followed by re-applying the verified migration set. Restore is a
  deliberate operator action recorded in the incident log; the migration ledger
  is never hand-edited.

## Testing

`pnpm test` runs the unit suite (contracts, checksums, ordering, locking,
rollback, manifest drift, CLI exit codes) and, when
`TAXDESK_MIGRATIONS_TEST_DATABASE_URL` is set, the PostgreSQL integration suite.
The integration tests refuse to run unless the target database name ends in
`_test`, so they cannot touch development, staging, or production data. They
cover a clean-database apply, idempotent re-runs, checksum drift after apply, and
transaction rollback of a failing migration.

```bash
dropdb --if-exists taxdesk_migrations_test && createdb taxdesk_migrations_test
TAXDESK_MIGRATIONS_TEST_DATABASE_URL="postgres://<role>@localhost:5432/taxdesk_migrations_test?sslmode=disable" \
  pnpm test:migrations
```

---
title: Continuous integration and staging delivery
status: accepted
version: 1.0
owners: [engineering, operations]
last_reviewed: 2026-11-04
related:
  - environments.md
  - migrations.md
  - ../product/prd/epic-00-foundation-and-platform.md
  - ../product/definition-of-done.md
---

# Continuous integration and staging delivery

TD-006 adds the delivery pipeline: every change runs the full quality gate, a
successful `main` build deploys the isolated staging stack, and recovery posture
is checked on every deploy and on a daily schedule. The pipeline is defined in
four GitHub Actions workflows:

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Pull request, push to `main`, manual | Install, type check, lint, format, tests, migration checksums, clean-database migrations, secret scans, build |
| `.github/workflows/deploy-staging.yml` | Successful `CI` run for a `main` push, manual SHA dispatch | Apply staging migrations, verify database/recovery posture, deploy the Worker and Pages app, smoke-test the Pages host |
| `.github/workflows/platform-posture.yml` | Daily schedule, manual | Re-validate recovery, independent export, and alerting evidence and verify the latest export manifest in R2 (`pnpm ci:backup-verify`); open or update an operator issue on failure |
| `.github/workflows/backup-export.yml` | Daily schedule, manual | TD-707: encrypted `pg_dump` export of staging to Cloudflare R2 with a manifest, verified after upload; open or update an operator issue on failure |

Pull-request runs never read repository or environment secrets. The CI workflow
declares `permissions: contents: read`, and the workflow policy gate rejects a
`pull_request` workflow that enters an environment or references `secrets.*`.

## Required checks

Configure branch protection for `main` with these required status checks and no
bypass:

- `Quality gates`
- `Clean database migrations`
- `Secret history scan`

The staging deployment is a separate workflow. It runs only after a successful
push run on `main` (`workflow_run.conclusion == 'success'`,
`workflow_run.event == 'push'`, `workflow_run.head_branch == 'main'`) or after a
manual dispatch of a full 40-character commit SHA. It never runs for a pull
request.

## Jobs and gates

### Quality

| Step | Command | Purpose |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Reproducible dependency graph |
| Types | `pnpm typecheck` | Strict TypeScript across the workspace |
| Lint | `pnpm lint` | ESLint plus package-boundary rules |
| Format | `pnpm format:check` | Prettier check, no auto-fix in CI |
| Tests | `pnpm test` | Unit and component tests in every package |
| Migration history | `pnpm db:migrate:verify` | Checksums match the committed manifest |
| Secrets | `pnpm ci:secrets` | Scans tracked files for secrets and forbidden credential files |
| Workflow policy | `pnpm ci:workflows` | Enforces the CI and deployment rules in this document |
| Staging config | `pnpm ci:config-posture` | Confirms the staging Hyperdrive ID/binding has no local connection string, the Pages preview binds to the staging Worker, and the database client requires TLS |
| Gate proof | `pnpm ci:selftest` | Fails if a secret, unsafe workflow, or failing recovery evidence is *not* rejected |
| Build | `pnpm build` | Every package builds for its deployment target |

`pnpm verify` runs the same gates locally, including `ci:secrets`, `ci:workflows`,
and `ci:selftest`.

### Clean database migrations

A disposable PostgreSQL service runs the forward-only migration suite:

1. `pnpm db:migrate:verify` checks the committed checksum manifest.
2. `pnpm db:migrate` applies every migration to a database that did not exist
   before the job.
3. `pnpm db:migrate:status --check` fails if anything is still pending.
4. `pnpm test:migrations` runs the PostgreSQL integration suite, including
   idempotent re-runs, checksum drift, and rollback of a failing migration.

The CI database is `taxdesk_migrations_test`; the integration suite refuses to
run against a database name that does not end in `_test`.

### Secret scanning

Two independent scans run for every change:

1. `gitleaks` scans the full Git history (`fetch-depth: 0`). A reviewed false
   positive is excepted only by its exact finding fingerprint in
   `.gitleaksignore`, with a comment explaining why; fix the source as well so
   new commits do not repeat it.
2. `pnpm ci:secrets` scans every tracked file with high-confidence rules
   (private-key blocks, cloud and GitHub tokens, JWTs, generic credential
   assignments) and rejects tracked `.env`, `.dev.vars`, private-key files, and
   `.wrangler/` state.

Neither scanner prints a matched value. Findings contain only the file path,
line number, and rule ID. Documented placeholders such as
`REPLACE_WITH_STAGING_HYPERDRIVE_ID` and `<password>` are allowed.

## Secret isolation

| Context | Available secrets | Environment |
| --- | --- | --- |
| Pull request from this repo or a fork | None beyond the read-only `github.token` | None |
| Push to `main` (CI) | None beyond the read-only `github.token` | None |
| Staging deployment | `STAGING_DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PLATFORM_POSTURE_EVIDENCE_JSON` | `staging` |
| Scheduled posture check | `PLATFORM_POSTURE_EVIDENCE_JSON` | `staging` |
| Production | Not deployed by TD-006 | `production`, required reviewers |

Create the `staging` GitHub environment with these environment secrets:

```text
STAGING_DATABASE_URL           postgres://<app-role>:<password>@<host>:5432/taxdesk_staging?sslmode=require
CLOUDFLARE_API_TOKEN           token scoped to the staging Worker and Pages projects
CLOUDFLARE_ACCOUNT_ID          Cloudflare account ID
PLATFORM_POSTURE_EVIDENCE_JSON the secret-free posture record described below
```

Create the non-secret environment variable `STAGING_WEB_URL` with the staging
Pages branch URL. Configure the `staging` environment with a deployment branch
rule limited to `main` and required reviewers; manual dispatch is additionally
restricted to a full 40-character commit SHA. Production secrets are stored only
in the `production` environment, which must require reviewers and restrict
deployment to `main`. TD-006 does not deploy production.

The workflow policy gate rejects:

- `pull_request_target`;
- a `pull_request` workflow with `environment:` or `secrets.*`;
- a workflow that reads secrets outside an environment;
- write permissions other than the scheduled posture workflow's `issues: write`;
- floating action refs (`@main`, `@latest`, or any non-tag/non-SHA ref);
- an unguarded `workflow_run` deployment;
- a manual deployment ref that is not validated as a 40-character SHA.

## Staging deployment

The staging deployment performs these steps in order:

1. Validate the deployment commit is a full SHA.
2. Check out exactly that commit.
3. Install dependencies from the committed lockfile.
4. `pnpm ci:config-posture` — the committed staging Hyperdrive binding has a
   concrete ID, no local connection string, the Pages preview binds to the
   staging Worker, and the database client requires TLS.
5. `pnpm db:migrate:verify`.
6. `pnpm db:migrate` with `STAGING_DATABASE_URL`.
7. `pnpm db:migrate:status --check`.
8. `pnpm ci:db-posture` — TLS session, TLS-required connection string, and
   least-privilege role attributes read from PostgreSQL.
9. `pnpm ci:backup-check` — validates `PLATFORM_POSTURE_EVIDENCE_JSON` for
   point-in-time recovery, independent exports, and alerting.
10. `pnpm deploy:api:staging` with `RELEASE_VERSION` set to the deployed SHA.
11. `pnpm deploy:web:staging`.
12. `pnpm ci:staging-smoke` against `STAGING_WEB_URL` with the expected release
    SHA.

The smoke check verifies health, app info, the Problem Details error contract,
request-ID propagation, the `no-store` cache header, and that no response
contains a connection string or secret marker.

Every gate fails closed. A missing posture secret, stale evidence, failed export,
disabled PITR, elevated database role, missing migration, or failed smoke check
stops the deploy before or immediately after the affected step.

## Recovery and alerting evidence

The posture gate is a provider-neutral, strict Zod contract in
[`packages/platform/src/contracts.ts`](../../packages/platform/src/contracts.ts).
Store the record as the `PLATFORM_POSTURE_EVIDENCE_JSON` secret. It must contain
no host names, database names, credentials, tokens, or client data.

```json
{
  "schemaVersion": 1,
  "environment": "staging",
  "recordedAt": "2026-11-04T11:00:00Z",
  "recordedBy": "Platform operator",
  "databaseProvider": "managed-postgres",
  "database": {
    "connectionUsesTls": true,
    "tlsEnforcedByApplication": true,
    "roleIsLeastPrivilege": true,
    "roleIsDatabaseOwner": false
  },
  "pointInTimeRecovery": {
    "enabled": true,
    "retentionDays": 7,
    "verifiedAt": "2026-11-03T11:00:00Z",
    "method": "provider-console"
  },
  "independentExports": {
    "enabled": true,
    "provider": "independent-object-store",
    "storedOutsideDatabaseProvider": true,
    "encrypted": true,
    "cadenceHours": 24,
    "lastSuccessAt": "2026-11-04T10:00:00Z",
    "retentionDays": 30
  },
  "alerting": {
    "configured": true,
    "channel": "operations-issue-queue",
    "testedAt": "2026-11-03T11:00:00Z",
    "testFailureAlerted": true
  }
}
```

Record it after provisioning or changing the staging database, after verifying a
PITR restore window, after a successful independent export, and after a
simulated failed export reaches the operator. The daily workflow re-validates
freshness: evidence older than 30 days, PITR verification older than 30 days,
an export older than twice the cadence, or an alerting test older than 90 days
fails the check.

When the daily check fails, the workflow opens (or comments on) an
operator-visible GitHub issue titled `Platform posture check failed`, containing
only the run URL. It never posts evidence values. Fix the cause, update the
evidence secret, and re-run `Platform posture`.

## Proving a failing gate blocks delivery

`pnpm ci:selftest` runs on every CI build and proves three gates reject a
deliberately failing input:

- a synthetic AWS key is detected by the secret scanner;
- a `pull_request` workflow that enters `production` and reads
  `secrets.PRODUCTION_DATABASE_URL` is rejected;
- posture evidence with PITR disabled, exports inside the provider, a stale
  export, and an unproven failure alert is rejected.

For a manual demonstration, open a pull request that intentionally breaks a
type check, lint rule, test, migration checksum, or secret scan. The required
check turns red and the PR cannot merge while branch protection is enabled.

## Local commands

| Command | Purpose |
| --- | --- |
| `pnpm ci:secrets` | Scan tracked files for secrets |
| `pnpm ci:workflows` | Enforce the workflow security policy |
| `pnpm ci:config-posture` | Verify the committed staging Hyperdrive/Pages config |
| `pnpm ci:selftest` | Prove the gates reject failing inputs |
| `pnpm ci:db-posture` | Verify staging TLS and role privileges (`DATABASE_URL`) |
| `pnpm ci:backup-check` | Validate posture evidence (`--evidence <path>` or `PLATFORM_POSTURE_EVIDENCE_JSON`) |
| `pnpm ci:staging-smoke` | Smoke-test a deployed Pages host (`STAGING_WEB_URL`) |
| `pnpm ci:backup-verify` | Check the latest export manifest (`--manifest`, optional `--artifact`, `--max-age-hours`) |

The Epic 7 operations commands (`pnpm ops:backup-export`, `ops:backup-decrypt`,
`ops:recovery-snapshot`, `ops:restore-verify`, `ops:sample-import`) are
documented in [`../guides/backup-and-restore.md`](../guides/backup-and-restore.md)
and [`../guides/migration-rehearsal.md`](../guides/migration-rehearsal.md).

The workflow policy also requires `backup-export.yml`: it must run on a
schedule in a protected environment, run `pnpm ops:backup-export`, never read
production secrets, and alert on failure. Only it and `platform-posture.yml`
may request `issues: write`.

Every command prints one JSON report as its final stdout line and exits `0` on
success, `1` on a failed gate, and `2` on a usage error.

## Failure and rollback

- **Failed CI gate.** Fix the cause in the pull request. Do not merge or bypass
  the required check.
- **Failed staging deploy.** The previously deployed Worker and Pages versions
  remain live until the new deploy step succeeds. Re-run the workflow with the
  last good SHA from `main`, or fix forward with a new commit.
- **Failed migration.** The failing migration's transaction rolls back and no
  ledger row is written. Correct it with a new compensating migration; never
  edit an applied migration.
- **Failed posture gate.** Do not deploy while TLS, least privilege, PITR,
  independent exports, or alerting are unverified. Restore the control, update
  the posture evidence, and re-run the workflow.
- **Smoke failure after deploy.** Treat the release as failed, inspect the
  Worker logs by request ID, and redeploy the last good SHA if needed.

See [migrations.md](migrations.md) for the migration-specific recovery path and
[environments.md](environments.md) for the environment and secret matrix.

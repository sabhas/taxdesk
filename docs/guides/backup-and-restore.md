---
title: Backup and restore runbook
status: draft
version: 1.0
owners: [engineering]
last_reviewed: 2026-11-14
related:
  - ../technical/environments.md
  - ../technical/ci.md
  - ../adr/0009-data-import-and-independent-backups.md
  - administrator-recovery.md
---

# Backup and restore runbook (TD-707, TD-708)

Recovery objective: TaxDesk is usable again within **four hours** (RTO) of the
decision to restore. Two independent recovery paths exist:

1. **Managed backups and point-in-time recovery** in the database provider
   (first choice; least data loss).
2. **Independent encrypted daily exports** stored in Cloudflare R2, outside the
   database provider (used when the provider or its backups are unavailable).

## Backup layers

| Layer | What | Where | Checked by |
| --- | --- | --- | --- |
| Managed backups + PITR | Provider automated backups and WAL retention | Database provider | Operator evidence `PLATFORM_POSTURE_EVIDENCE_JSON`, `pnpm ci:backup-check` (daily, `platform-posture.yml`) |
| Independent export | `pg_dump` custom-format archive, AES-256-GCM encrypted, with a manifest | R2 bucket `vars.BACKUP_BUCKET`, prefix `<environment>/` | `backup-export.yml` (daily) and `pnpm ci:backup-verify` in `platform-posture.yml` |

### Independent export

`backup-export.yml` runs daily in the protected `staging` environment:

1. `pnpm ops:backup-export --out exports --environment staging --retention-days 35 --storage cloudflare-r2`
   - reads the database with `STAGING_BACKUP_DATABASE_URL` (a read-only role is
     enough; credentials go to `pg_dump` through libpq environment variables,
     never the command line);
   - encrypts the archive with `BACKUP_ENCRYPTION_KEY` (32 random bytes,
     base64url, stored only as a deployment secret and in the operator's
     offline key store);
   - writes `taxdesk-staging-<UTC stamp>.dump.enc`, a matching
     `.manifest.json`, and `latest.manifest.json`.
2. Uploads the files to R2 (the manifest is uploaded even when the export
   fails, so a failure is visible).
3. Downloads the uploaded manifest and runs `pnpm ci:backup-verify` against the
   artifact digest.
4. Opens or updates an issue titled **Independent backup export failed** on any
   failure.

The manifest records: status and failure code, start/finish time and
duration, the source PostgreSQL version, the newest applied migration (schema
version) and migration count, the release commit, the artifact name, size,
SHA-256, encryption and key version, and the retention days, expiry, and
storage label. It never holds a host, database name, credential, or record.

Retention: the manifest records 35 days. Configure an R2 lifecycle rule on the
bucket to delete objects under `staging/` (and later `production/`) after 35
days; keep `latest.manifest.json` excluded or rewritten daily.

### Monitoring and alerts

`platform-posture.yml` runs daily and fails (opening **Platform posture check
failed**) when:

- managed backup, PITR, alerting, or export evidence is missing or stale
  (`pnpm ci:backup-check`); or
- the latest independent export is missing, failed, older than 30 hours, has
  no source version, or keeps less than 30 days (`pnpm ci:backup-verify`).

## Restore procedure

Record each step's time in the evidence form below; the clock starts at the
decision to restore.

1. **Declare and freeze.** Record the incident start time (UTC). Stop writes:
   set the Worker to maintenance (deploy the previous build with a maintenance
   flag, or remove the Pages route) so no new data is lost into the failed
   database.
2. **Take a source snapshot if the source still answers** (it is the
   comparison baseline):
   `DATABASE_URL=<source> pnpm ops:recovery-snapshot --out source-snapshot.json`.
   If the source is gone, use the snapshot recorded at the last rehearsal or
   the counts the firm reports, and note it.
3. **Choose the path.**
   - *Managed PITR:* restore the provider backup to a new database at the
     chosen time, using the provider console. Note the restore point.
   - *Independent export:* download the newest `.dump.enc` and its manifest
     from R2, then:
     ```bash
     pnpm ci:backup-verify --manifest <file>.manifest.json --artifact <file>.dump.enc --max-age-hours 9999
     BACKUP_ENCRYPTION_KEY=<from the offline key store> \
       pnpm ops:backup-decrypt --in <file>.dump.enc --out restore.dump
     createdb <new database>   # on the recovery database server
     pg_restore --no-owner --no-privileges --exit-on-error -d <new database URL> restore.dump
     ```
     Delete `restore.dump` once the restore is verified.
4. **Restore roles and posture.** Create the least-privilege application role
   and grants as in [environments.md](../technical/environments.md), then run
   `DATABASE_URL=<new database> pnpm ci:db-posture`.
5. **Verify the restore.**
   ```bash
   DATABASE_URL=<new database> pnpm ops:restore-verify \
     --expected source-snapshot.json \
     --incident-start <UTC time from step 1> \
     --mfa-key-versions 1 \
     --out restore-evidence.json
   ```
   It checks that every committed migration is applied with its checksum; the
   firm is bootstrapped; at least one active administrator has MFA; every
   MFA-enrolled user has a confirmed credential; the stored MFA key versions are
   held by the target environment; case status matches each case's newest
   history row; every invoice's paid amount equals payments minus reversals;
   record counts, money totals, and case counts by status match the source;
   and the elapsed time is within four hours.
6. **Point the application at the new database.** Update the Hyperdrive
   configuration for the environment, confirm `ENVIRONMENT`, secrets
   (`MFA_ENCRYPTION_KEY`, `CLIENT_DATA_ENCRYPTION_KEY`,
   `CLIENT_IDENTIFIER_INDEX_KEY`, `STORAGE_TOKEN_ENCRYPTION_KEY`, Turnstile
   keys) are unchanged, and redeploy.
7. **Functional check.** Sign in as an administrator with MFA; open a client
   (masked identifiers show), a case (status and history), an invoice
   (balance and payments), and a document (opens from storage). Run
   `pnpm ci:staging-smoke`.
8. **Reopen** and record the recovery time.

Documents live in OneDrive, not PostgreSQL, so a database restore does not
restore files; run storage reconciliation after a restore to flag any document
whose provider item no longer exists.

## Restore rehearsal (TD-708)

Rehearse in an **isolated** environment (a separate database, never the live
staging or production database) at least before launch and then quarterly.

### Evidence form

| Field | Value |
| --- | --- |
| Rehearsal date | |
| Environment restored from | |
| Path (managed PITR / independent export) | |
| Artifact or restore point | |
| Incident start (UTC) | |
| Restore complete (UTC) | |
| `restore-verify` result and `recoveryMinutes` | |
| Administrator MFA sign-in on restored copy | ☐ |
| Client / case / invoice / document spot checks | ☐ |
| Within four-hour RTO | ☐ |
| Performed by | |
| Reviewed by | |

Keep `restore-evidence.json` (it contains counts and totals only) with the
form. The local dry run of this procedure, which proves the tooling but not
the staging path, is recorded in
[`docs/product/evidence/README.md`](../product/evidence/README.md).

---
title: "ADR 0009: Retry-safe CSV import and independent encrypted backups"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - ../product/prd/epic-07-migration-security-and-recovery.md
  - ../technical/data-model.md
  - ../guides/data-import.md
  - ../guides/backup-and-restore.md
  - ./0004-client-identifier-protection-and-visibility.md
  - ./0007-billing-integrity-and-idempotency.md
---

# ADR 0009: Retry-safe CSV import and independent encrypted backups

Status is `proposed` until the Product Owner accepts Epic 7 in Sprint Review.

## Context

Epic 7 brings existing records into TaxDesk and must prove recovery before
real data arrives. An import is a bulk write path that touches encrypted
identifiers and money, runs inside a Worker request with CPU limits, and must
survive a dropped connection without duplicating a client or billing a balance
twice. Backups must survive the loss of the database provider.

## Decisions

1. **Imports are administrator-only.** A new `imports.manage` permission
   (administrator only) guards templates, dry runs, decisions, commits, and
   exports. Managers can no longer bulk-create records through any path.
2. **The file is never stored.** A dry run keeps the file name, size, row count,
   SHA-256 checksum, and one plan row per data row. Revalidate and commit send
   the same file again and must match the checksum. This keeps plaintext CNIC,
   NTN, names, and contact details out of import tables; row errors are column
   names with fixed codes and messages, never cell values.
3. **One open batch per file.** A partial unique index on the checksum (for
   batches that are not discarded) stops the same file from being planned or
   committed twice in parallel; discard to reuse it.
4. **External references are the import identity.** Each row's `external_ref`
   is recorded with the record it created, updated, or linked to. A unique index
   allows one created record per kind and reference, so a re-import updates
   (clients) or skips (cases, balances) instead of duplicating. Later templates
   refer to earlier rows by that reference or by business code.
5. **Bounded, resumable commit.** The commit claims the batch with its
   `Idempotency-Key` (stored on the batch; immutable once set), then writes
   rows in transactions of 100. Each transaction locks the batch, re-plans its
   rows against current data, writes the records with their normal audit
   events, and records each row's outcome. A retry with the same key resumes at
   the next row without an outcome; a different key is refused while a commit
   is in progress or after it finished. A commit is refused before it starts if
   re-planning would change any row (`IMPORT_STALE`).
6. **Same invariants as interactive writes.** Imported clients use the same
   identifier protection and duplicate rules; cases copy the latest published
   workflow version and record their imported status as history; opening
   balances become finalized invoices numbered from the gapless invoice
   counter. Similar-name matches need an administrator decision with a reason;
   exact identifier matches link to the existing client.
7. **Independent backups are encrypted exports in R2.** A daily job runs
   `pg_dump` (credentials via libpq environment variables), encrypts the archive
   with AES-256-GCM under `BACKUP_ENCRYPTION_KEY`, and stores it with a
   manifest (status, failure code, source schema version, release, digest,
   retention) in Cloudflare R2, outside the database provider. The manifest is
   uploaded on failure too, and the daily posture job fails and alerts when the
   latest export is missing, failed, stale, or under-retained.
8. **Restores are verified by numbers, not by eye.** A recovery snapshot (table
   counts, money totals, case counts by status, integrity checks) is compared
   between source and restored copy, together with schema checksums,
   administrator MFA readiness, MFA key availability, and the four-hour RTO.

## Consequences

- Administrators must keep the CSV file until the commit finishes (the page
  keeps it in memory for the session and asks for it again otherwise).
- A 5,000-row commit is the largest unit; very large sources are split into
  several files. The rehearsal measures commit time against the Worker CPU
  limit.
- An imported finalized invoice cannot be edited; a wrong balance is voided and
  re-imported under a new reference.
- Losing `BACKUP_ENCRYPTION_KEY` makes the independent exports unreadable; the
  key is kept in the operator's offline key store as well as the deployment
  secret.
- `drizzle-orm`, `zod` (now v4), `hono`, `vite`, and `vitest` were upgraded to
  clear critical and high advisories found in the security review (TD-709).

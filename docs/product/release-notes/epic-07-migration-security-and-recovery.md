---
title: "Release note: Epic 7 migration, security, and recovery"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - ../prd/epic-07-migration-security-and-recovery.md
  - ../../adr/0009-data-import-and-independent-backups.md
  - ../../guides/data-import.md
  - ../../guides/migration-rehearsal.md
  - ../../guides/backup-and-restore.md
  - ../security-review-2026-11.md
  - ../production-readiness-review.md
---

# Release note: Epic 7 migration, security, and recovery (TD-701–TD-710)

Draft until the staging demonstration, the signed migration and restore
rehearsals, and Sprint Review acceptance.

## What users can do

- **Data import** (administrators only): download versioned templates for
  clients, active cases, and opening balances; run a dry run that shows what
  each row would create, update, or skip, with row-level errors by column;
  decide possible duplicates with a recorded reason; and commit. A dropped
  connection during a commit is resumed with the same file, and nothing is
  imported twice. Each batch shows a reconciliation of source rows and amounts
  against what was written.
- **Exports**: an exceptions CSV (errors, skips, decisions, failures) for any
  batch and a lineage CSV linking every committed row to the record it created
  or updated. Neither repeats a cell value.
- **Migration reconciliation**: totals of clients, active cases, and opening
  balances in TaxDesk and created by import, with a random sample of imported
  rows to check against the source.

Opening balances become finalized invoices numbered from the firm's invoice
sequence; record payments against them as usual.

## Roles

| Role | Data import | Template download | Decisions | Commit | Exports |
| --- | --- | --- | --- | --- | --- |
| Administrator | yes | yes | yes | yes | yes |
| Manager, Consultant, Billing, Read-only | no | no | no | no | no |

## Data changes

- Migration `0010_data_import.sql` adds `import_batches`, `import_batch_rows`,
  `import_batch_code_seq`, and the administrator-only `imports.manage`
  permission, with triggers that keep committed batches and row lineage
  immutable and never deleted. Import tables hold no cell values.
- Imported clients, cases, and invoices are ordinary records with their usual
  audit events, tagged with the batch code and row number.

## Security and dependency changes

- Security review (TD-709): no critical or high finding remains. Upgraded
  `zod` 3 → 4, `drizzle-orm` 0.38 → 0.45, `hono` → 4.13.18, `vite` 5 → 6,
  `vitest` 2 → 4, and `esbuild` → 0.25. Lower findings have owners and due
  dates in the review.

## Operational actions

- Apply migration `0010` in staging. No new Worker secret.
- For the independent backup export, add to the `staging` GitHub environment:
  `BACKUP_ENCRYPTION_KEY` (also stored offline), `STAGING_BACKUP_DATABASE_URL`,
  `BACKUP_R2_API_TOKEN`, and the variable `BACKUP_BUCKET`; create the R2 bucket
  with a 35-day lifecycle rule. Then run **Independent backup export** once by
  hand and confirm **Platform posture** stays green.
- Run the migration rehearsal and sign the checklist
  ([guide](../../guides/migration-rehearsal.md)).
- Run and record the restore rehearsal in an isolated environment
  ([runbook](../../guides/backup-and-restore.md)).
- Review the security findings and complete the
  [production readiness review](../production-readiness-review.md).

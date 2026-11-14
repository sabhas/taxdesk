---
title: Migration rehearsal and reconciliation checklist
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - data-import.md
  - backup-and-restore.md
  - ../product/prd/epic-07-migration-security-and-recovery.md
---

# Migration rehearsal (TD-706)

The rehearsal imports a sanitized, production-shaped data set into **staging**
and reconciles it against the source before any real record enters production.
Staging holds synthetic data only: never load real client data there.

## 1. Prepare the data set

Either export the firm's spreadsheets into the three templates and **sanitize**
them (replace every name, CNIC, NTN, email, and phone with generated values
while keeping the row counts, relationships, dates, and amounts), or generate a
synthetic set of the same shape:

```bash
pnpm ops:sample-import --out ./rehearsal --clients 800 --seed 7 \
  --service "Income tax return" --tax-year 2026 --as-of 2026-06-30 --with-exceptions
```

This writes `clients-v1.csv`, `cases-v1.csv`, `opening_balances-v1.csv`, and
`source-totals.json` (the source-side counts and total). Values are generated:
CNICs use the `00000` region and emails use `example.test`. With
`--with-exceptions` the clients file also contains three rows the dry run must
catch: an invalid email, a repeated CNIC, and a possible duplicate name.

Size the set to the real firm (client count, active cases, balances).

## 2. Prepare staging

1. Confirm staging runs the release candidate and migration `0010` is applied
   (`pnpm db:migrate:status --check`).
2. Create the service named in the cases file with a default workflow
   template that has a published version.
3. Take a recovery snapshot before the import so the rehearsal can be repeated
   from a restore: `DATABASE_URL=<staging> pnpm ops:recovery-snapshot --out before.json`.

## 3. Import and review

For each file, in order (clients, cases, opening balances):

1. Run the dry run in **Data import**. Record the batch code and the proposed
   counts.
2. Download the **Exceptions CSV**. Every exception must be explained: correct
   the source and run a new dry run, or record a decision with a reason for a
   possible duplicate. With `--with-exceptions`, confirm all three planted rows
   were caught.
3. Commit. Note the time the commit took for the largest file.
4. Confirm the batch shows **Reconciled**.

## 4. Reconcile

Open **Migration reconciliation** and fill in the checklist. Source values come
from the source system (or `source-totals.json`); TaxDesk values from the page
and the batch results.

| # | Check | Source | TaxDesk | Match |
| --- | --- | --- | --- | --- |
| 1 | Clients (rows in the clients file, minus intentional skips) | | Clients created by import | ☐ |
| 2 | Clients total in TaxDesk equals pre-existing + imported | | Clients in TaxDesk | ☐ |
| 3 | Active cases | | Active cases in TaxDesk / created by import | ☐ |
| 4 | Opening balances: number of balances | | Opening-balance invoices | ☐ |
| 5 | Opening balances: total amount | | Opening balances invoiced | ☐ |
| 6 | No row failed at commit | 0 | Rows that failed at commit | ☐ |
| 7 | Every exception has a correction or a recorded decision | | Exceptions CSV reviewed | ☐ |
| 8 | Sampled records (at least 10, from the sample list): name, type, masked identifier, contact, case service/year/status, balance, and invoice number agree with the source row | | Lineage CSV + record pages | ☐ |
| 9 | Relationships: each sampled case and balance belongs to the right client | | | ☐ |
| 10 | A consultant sees only assigned imported clients and cases | | | ☐ |

Keep the batch codes, both CSV exports, the reconciliation page totals, and
`source-totals.json` with this checklist as evidence.

## 5. Sign-off

The rehearsal is accepted only when every check matches or a difference is
explained and accepted.

| Role | Name | Decision | Date | Notes |
| --- | --- | --- | --- | --- |
| Product Owner | | ☐ Accept ☐ Reject | | |
| Engineering lead | | ☐ Accept ☐ Reject | | |

Record the signed outcome in `docs/product/status.md` and the production
readiness review. Production import (Epic 8) uses the same templates and steps.

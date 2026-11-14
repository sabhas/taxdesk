---
title: Data import guide
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - ../product/prd/epic-07-migration-security-and-recovery.md
  - ../adr/0009-data-import-and-independent-backups.md
  - ../technical/data-model.md
  - migration-rehearsal.md
---

# Data import guide

Administrators bring existing clients, active cases, and opening balances into
TaxDesk with versioned CSV templates (TD-701–TD-705). Nothing is written until
a dry run is clean and an administrator commits it.

Open **Data import** in the navigation (administrators only; the API requires
the `imports.manage` permission for every import endpoint).

## Templates

| Template | File | Creates | Import order |
| --- | --- | --- | --- |
| `clients.v1` | [`clients-v1.csv`](../templates/imports/clients-v1.csv) | Clients, with one primary contact | 1 |
| `cases.v1` | [`cases-v1.csv`](../templates/imports/cases-v1.csv) | Open tax cases | 2 |
| `opening_balances.v1` | [`opening-balances-v1.csv`](../templates/imports/opening-balances-v1.csv) | One finalized invoice per balance | 3 |

The committed files, the download in the app
(`GET /api/v1/imports/templates/{id}/csv`), and the shared contract
(`IMPORT_TEMPLATES` in `@taxdesk/shared`) are the same; a test fails if they
drift. Example rows are synthetic: CNICs use the impossible `00000` region and
emails use `example.test`. Never put real client data in a template, fixture,
or test.

A later template version (`clients.v2`) will be added beside v1, never by
changing v1, so a file prepared for v1 keeps validating the same way.

### File rules

- UTF-8 CSV (RFC 4180). A byte-order mark, CRLF or LF line endings, quoted
  cells, doubled quotes, and newlines inside quotes are accepted.
- The header row must contain exactly the template's column names, in any
  order. Missing, unknown, or repeated columns reject the whole file.
- At most 2 MiB and 5,000 data rows per file, 4,000 characters per cell. Split
  larger sources into several files.
- Blank lines are ignored. Cells are trimmed.
- Row numbers in messages count the header as row 1, so row 2 is the first
  data row, as in a spreadsheet.
- Every row needs an `external_ref`: the record's identifier in the old system
  (1–64 letters, digits, `.`, `_`, `/`, `-`, unique within the file). It links
  the row to the record it creates and makes a re-import safe.

### `clients.v1`

| Column | Required | Format and normalization |
| --- | --- | --- |
| `external_ref` | always | See above. Re-importing a reference updates that client instead of creating another. |
| `client_type` | always | `individual` or `business` (case-insensitive). Cannot change later. |
| `legal_name` | always | Up to 200 characters. |
| `display_name` | no | Up to 200 characters; defaults to the legal name. |
| `cnic` | individual | 13 digits, with or without hyphens. Must be empty for a business. Encrypted with a blind index; never stored in plain text. |
| `ntn` | business | 7 digits with an optional check digit, or a 13-digit CNIC-based NTN. Optional for an individual. Encrypted. |
| `contact_name` | no | Primary contact. When set, give `contact_email` or `contact_phone`. |
| `contact_relationship` | no | Up to 80 characters. |
| `contact_email` | no | Stored lowercase for duplicate checks. |
| `contact_phone` | no | 7–15 digits. `0300…` is stored as `92300…`. |
| `assigned_manager_username` | no | An active staff member's username. |
| `notes` | no | Up to 4,000 characters; never copied into audit history. |

Contacts are written only when a client is created. A re-import updates the
legal name, display name, notes, and assigned manager; it never changes the
type, CNIC, or NTN (a different value is an `IDENTIFIER_CHANGED` error).

### `cases.v1`

| Column | Required | Format |
| --- | --- | --- |
| `external_ref` | always | A row already imported is skipped. |
| `client_ref` | always | A client code (`CL-00001`) or a `clients.v1` external reference that was already committed. The client must not be archived. |
| `service` | always | The name of an active service, case-insensitive. The service needs a default workflow template with a published version; the case uses its latest published version. |
| `tax_year` | always | 2000–2100. |
| `due_date` | no | `YYYY-MM-DD`. Defaults to the import date (firm timezone) plus the service's deadline offset. |
| `status` | no | The key of an **open** status in that workflow (for example `in_preparation`). Defaults to the initial status. Only active work is imported. The case history records the initial status and the move to the imported status. |
| `primary_consultant_username`, `reviewer_username` | no | Active staff who can work cases; the reviewer must differ from the consultant. Leave the consultant empty for the unassigned queue. |
| `notes` | no | Up to 4,000 characters. |

An open case for the same client, service, and tax year is linked, not
duplicated (`EXISTING_CASE`). Two rows for the same client, service, and year
in one file are an error.

### `opening_balances.v1`

| Column | Required | Format |
| --- | --- | --- |
| `external_ref` | always | A row already imported is skipped, so a balance is never billed twice. |
| `client_ref` | always | As for cases. |
| `case_ref` | no | A case code (`TC-00001`) or a committed `cases.v1` external reference. The case must belong to the same client. |
| `as_of_date` | always | `YYYY-MM-DD`, not in the future. Becomes the invoice issue date. |
| `due_date` | no | On or after `as_of_date`. |
| `amount` | always | PKR above zero with at most two decimals; thousands separators allowed (`12,500.50`). |
| `description` | no | Up to 300 characters; defaults to `Opening balance as of <date>`. |

Each row becomes a **finalized** invoice for the amount, numbered from the
firm's invoice sequence, with one line item and no payments. Record later
payments against it as usual. The invoice cannot be edited; correct a mistake
by voiding it and importing a corrected row with a new external reference.

## Dry run, review, and commit

1. **Dry run.** Choose the template and the file. TaxDesk records the file
   name, size, row count, and SHA-256 checksum, checks every row, and shows the
   proposed creates, updates, skips, possible duplicates, and errors. It
   writes no client, case, or invoice. The file itself is not stored.
2. **Errors** list the column and a fixed reason (for example
   `contact_email: The value does not match the documented format.`). Messages
   never repeat the cell value. Fix the source and run a new dry run; a batch
   with errors can never be committed.
3. **Possible duplicates** are rows that look like an existing client (same
   name, email, or phone) or another row in the file, without an identical
   CNIC or NTN. An administrator decides **Skip** or **Create anyway** and must
   give a reason of at least 10 characters. The decision, its reason, and its
   author are kept on the row and in the audit history (`import.row_decided`).
4. **Revalidate** re-plans the batch against current records with the same
   file, for example after adding a missing service. Decisions stay on rows
   that are still possible duplicates.
5. **Commit** sends the same file again (it must match the checksum) with an
   `Idempotency-Key`. If records changed since the dry run, the commit is
   refused (`IMPORT_STALE`): revalidate and review the new plan. Rows are
   written in transactions of 100; each created record has its usual audit
   event (`client.created`, `case.created`, `billing.invoice_finalized`) with
   the batch code and row number, and the batch ends with `import.committed`
   and its reconciliation.
6. **Interrupted commits resume.** If the connection drops, the batch shows
   **Committing**. Choose the same file and commit again: the same key resumes
   from the next unwritten row; a row is never written twice. Another key
   cannot take over a batch in progress, and a committed batch cannot be
   committed again.
7. **Discard** a batch that was not committed to upload the same file again.
   Only one open batch may hold a given file.

## Reconciliation and exports

- Each batch shows source rows against created, updated, skipped, failed, and
  pending rows. For opening balances it also compares the file's total with
  the invoiced amount plus skipped amounts. **Reconciled** means every row is
  accounted for, none failed, and the amounts add up.
- **Exceptions CSV** lists every error, skip, possible duplicate, decision, and
  failure. **Lineage CSV** (after commit) lists every row with the record type,
  ID, and code it created, updated, or linked to. Exports contain row numbers,
  external references, codes, fixed messages, record codes, and decision
  reasons, never cell values, and are recorded as `import.exceptions_exported`.
- **Migration reconciliation** on the Data import page totals clients, active
  cases, and opening balances in TaxDesk and created by import, and shows a
  random sample of imported rows to check against the source. Use it with the
  [migration rehearsal checklist](migration-rehearsal.md).

## Limits and failure handling

| Situation | Result |
| --- | --- |
| Not an administrator | `403` for every import endpoint |
| File over 2 MiB, over 5,000 rows, binary, malformed CSV, wrong header | `400 IMPORT_FILE_INVALID` (or `413`), nothing stored |
| Same file while a batch for it is open | `409 IMPORT_DUPLICATE_SOURCE` naming the batch |
| Commit with errors or undecided duplicates | `409 IMPORT_NOT_COMMITTABLE` |
| Commit with a different file | `409 IMPORT_SOURCE_MISMATCH` |
| Records changed since the dry run | `409 IMPORT_STALE`; revalidate |
| Retry of a finished commit with the same key | `200`, the same result, nothing written |
| Commit of a committed batch with another key | `409 IMPORT_ALREADY_COMMITTED` |
| Client identifier keys not configured | `503`; nothing stored |

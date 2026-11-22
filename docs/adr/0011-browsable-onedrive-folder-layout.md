---
title: "ADR 0011: Browsable OneDrive folder layout"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-22
related:
  - ../product/prd/epic-04-document-storage.md
  - ../technical/data-model.md
  - ./0006-provider-neutral-document-storage.md
---

# ADR 0011: Browsable OneDrive folder layout

Status is `proposed` until the Product Owner accepts TD-411 in Sprint Review.
This ADR supersedes the storage layout in ADR 0006, decision 2 ("Paths are
derived once from stable values — client code, tax year, case ID, document
ID"). The rest of ADR 0006 is unchanged.

## Context

ADR 0006 and TD-405 store each file at:

```
clients/<client code>/<tax year | general>/<case ID | client-documents>/<document ID>/<file name>
```

The firm's staff upload documents through TaxDesk, but they read them in
OneDrive, because the firm already uses Microsoft 365. In the TD-405 layout a
file is six folders deep, and two of those folders are UUIDs that mean nothing
to staff. Finding a file means opening several folders whose names they cannot
recognize.

TaxDesk does not need the UUID folders. Every document record keeps the
provider's external item ID (plus drive, parent, and ETag), and every open,
download, delete, restore, and reconciliation uses that ID. The path is used
only once, to create the file. The `<document ID>` folder existed only to keep
two files with the same name apart.

No real OneDrive account has been connected yet: staging still needs its
Microsoft app registration, and production has not launched. Changing the
layout now means no stored files have to move.

## Decisions

1. **Readable, stable folders.** New files are stored at:

   ```
   clients/<client code>/<tax year>/<case code>/<file name>     case documents
   clients/<client code>/general/<file name>                    client-level documents
   ```

   For example, `clients/CL-00001/2025/TC-00042/salary-certificate.pdf`. Every
   folder name is a code that never changes or is reused (`CL-00001`,
   `TC-00042`) or a tax year. Client and service names are left out on
   purpose: a client rename never leaves a stale folder name, nothing has to be
   renamed in OneDrive, and names never need cleaning for OneDrive's character
   rules.
2. **OneDrive resolves duplicate names.** Upload sessions use
   `@microsoft.graph.conflictBehavior: rename` instead of `fail`. A second
   `bank-statement.pdf` in the same folder is saved by OneDrive as
   `bank-statement 1.pdf`. TaxDesk keeps the file name the user uploaded as the
   document's display and download name, and the external item ID stays the
   only reference. No schema change is needed. Completion still checks the
   returned size, which a rename does not affect.
3. **Billing PDFs follow the same layout.** An invoice or receipt PDF for an
   individual invoice with a case goes in that case's folder. One without a
   case, including every combined group invoice (ADR 0010), goes in the
   invoice client's `general/` folder.
4. **Existing files stay where they are.** Files stored before this change
   keep their TD-405 paths and keep working through their item IDs. No
   migration command is built. Any staging test files can be left in place, or
   cleared by reconnecting staging to a fresh app folder.
5. **Staff may read the app folder in OneDrive.** Reading files directly in
   OneDrive is an accepted way of working for the firm. The storage account's
   owner shares the TaxDesk app folder with staff with view-only access. Moving,
   renaming, or deleting files in OneDrive stays forbidden, and reconciliation
   still reports such changes as `moved` or `missing`.

## Consequences

- Reading a file in OneDrive bypasses TaxDesk. ADR 0006 sends every TaxDesk
  download through the Worker so that permissions, assignment, deactivation,
  and audit are rechecked each time. A staff member who opens the shared folder
  in OneDrive can see every client's documents, regardless of TaxDesk roles or
  assignments, and those opens are not in the TaxDesk audit log. The firm
  accepts this. Offboarding must remove the person's OneDrive share as well as
  deactivate their TaxDesk account.
- The share must be view-only. With edit access, staff could move or delete
  files and break the link between records and storage.
- A retried billing PDF upload can leave an extra copy (such as
  `INV-00001 1.pdf`) next to the recorded one. This already happened under
  TD-405, but in a separate document-ID folder where staff did not see it. The
  recorded item ID is still the right file.
- A pre-assigned document ID no longer appears in the path. Upload idempotency
  is unchanged, because it relies on the request ID and the upload record, not
  on the path.
- The provider-neutral boundary is unchanged: the layout is still built in one
  domain function, and only the OneDrive adapter turns it into a Graph path.
- No migration, no new secrets, and no new permission are required.

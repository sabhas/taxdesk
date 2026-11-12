---
title: "Release note: Epic 4 document storage"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
related:
  - ../prd/epic-04-document-storage.md
  - ../../adr/0006-provider-neutral-document-storage.md
  - ../../technical/data-model.md
  - ../../technical/environments.md
---

# Release note: Epic 4 document storage (TD-401–TD-410)

Draft until staging demonstration and Sprint Review acceptance.

## What users can do

- **Connect storage** (administrators): **Settings → Document storage** connects
  the firm's OneDrive account once through Microsoft's consent screen. The page
  shows the connection health, who connected it and when, and when it was last
  checked. Administrators can check health on demand, reconnect, and
  disconnect. Staff never see or handle provider credentials.
- **Upload documents** from a case or a client page: choose a file (PDF, JPEG,
  PNG, DOCX, XLSX, or CSV, up to 250 MiB by default), a document type, and —
  on a case — the checklist item it satisfies. Uploads go in 5 MiB pieces with
  a progress bar; a dropped connection can be retried or resumed from where it
  stopped, and an upload can be paused or cancelled. Unsafe file names and
  unsupported types are refused before anything is sent.
- **Open documents**: authorized staff download a document through TaxDesk.
  Access is checked again on every open, and every open is recorded in the
  activity log.
- **Verify documents**: reviewers mark a document verified or rejected (with a
  reason), or reset the review. Each checklist row with a document type shows
  how many verified documents it has.
- **Delete and restore**: staff who can work a case can delete its documents;
  the file moves to the OneDrive recycle bin and the record is hidden by
  default ("Show deleted documents" reveals it). Managers and administrators
  can restore it while OneDrive can still recover it.
- **Reconcile** (administrators): **Run reconciliation** checks every stored
  document against OneDrive and reports how many are present, missing, moved,
  or found again, plus the recommended next step. Missing documents are flagged
  "Missing in storage"; nothing is deleted.

## Behavior changes

- A required checklist item that names a document type can now be completed
  only when it has at least one linked, verified document. If that document is
  later rejected, reset, unlinked, deleted, or found missing, an open case's
  item is reopened automatically and the change is logged.
- When OneDrive consent is revoked or expires, uploads, opens, deletes, and
  restores stop with a clear message; administrators get a reconnect link.
  Short provider outages are retried automatically and recover on their own.

## Data changes

- Migration `0007_document_storage.sql` adds `storage_connections`,
  `storage_oauth_states`, `documents`, `document_uploads`,
  `storage_reconciliation_runs`, and the administrator-only `storage.manage`
  permission. It is forward-only and adds no columns to existing tables.
- File contents never enter PostgreSQL. Documents keep OneDrive's item ID as
  their reference, never a path. Provider tokens and upload-session addresses
  are stored encrypted.

## Operational actions

1. Register a Microsoft app (Personal accounts) for staging with the redirect
   URI `<APP_PUBLIC_URL>/settings/storage/callback`, delegated
   permissions `Files.ReadWrite.AppFolder` and `offline_access`.
2. Set `ONEDRIVE_CLIENT_ID` (and `ONEDRIVE_AUTHORITY` if not `consumers`) in
   `[vars]`; `wrangler secret put STORAGE_TOKEN_ENCRYPTION_KEY` (32-byte
   base64url) and, for a confidential registration only,
   `ONEDRIVE_CLIENT_SECRET`. Make sure `APP_PUBLIC_URL` is set. See
   [environments](../../technical/environments.md#secret-sets).
3. Apply migration `0007` to staging before deploying the Worker.
4. Sign in as an administrator, connect storage, upload, open, verify, delete,
   restore, and run reconciliation with synthetic files only.
5. Revoke the app's consent in the Microsoft account and confirm that TaxDesk
   reports "reconnect required" and that reconnecting restores access.

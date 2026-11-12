---
title: "Epic 4: Provider-Neutral Document Storage"
status: in_progress
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
related:
  - ../roadmap.md
  - ../../technical/architecture.md
  - ../../technical/data-model.md
  - ../definition-of-done.md
---

# Epic 4: Provider-Neutral Document Storage

## Scope

Implement a provider-neutral document domain and use Microsoft OneDrive as the first storage adapter. Deliver protected upload/download, document metadata, checklist association, provider health, soft deletion, and reconciliation.

**Out of scope:** OCR, scanning, content search, document editing, malware scanning service, provider migration UI, and direct staff Microsoft login.

## Sprint 7 backlog — 18 points

### TD-401 — Storage provider port and fake adapter — 4 points

**User story:** As an engineer, I want business features isolated from OneDrive so that another storage service can replace it later.

- [x] Define and test `DocumentStorageProvider` methods for connection, upload, completion, download, metadata, health, and trash.
- [x] Implement an in-memory fake provider for service and route tests.
- [x] Prevent domain services from importing Graph or OneDrive libraries.

### TD-402 — Storage connection data and token encryption — 4 points

**User story:** As an administrator, I want the storage connection protected so that staff never handle provider credentials.

- [x] Store provider type, connection health, external drive/folder IDs, encrypted token payload, and key version.
- [x] Encrypt/decrypt tokens using AES-GCM with deployment secrets stored outside source control and the database.
- [x] Ensure tokens and provider authorization responses never reach browser logs or API responses.

### TD-403 — OneDrive administrator connection — 4 points

**User story:** As an administrator, I want to connect the firm OneDrive account once so that TaxDesk can store authorized documents.

- [x] Begin delegated OAuth only for administrators.
- [x] Validate callback state, complete consent, save connection metadata, and display health.
- [x] Support reconnect and explicit disconnect with audit events.

### TD-404 — Token refresh and health checks — 3 points

**User story:** As an operator, I want OneDrive failures visible early so that document work is not silently lost.

- [x] Refresh provider credentials atomically and retain rotation safety.
- [x] Mark revoked/expired connection unhealthy and stop new document operations safely.
- [x] Provide an administrator-only reconnect call to action.

### TD-405 — Stable storage layout — 3 points

**User story:** As the firm, I want documents organized by stable records so that client renames do not break access.

- [x] Derive provider paths from stable client code, tax year, case ID, and document ID.
- [x] Store external item ID and metadata as the durable reference.
- [x] Reject unsafe filenames and unsupported content types before upload starts.

## Sprint 8 backlog — 20 points

### TD-406 — Resumable document upload — 5 points

**User story:** As staff, I want to upload a document reliably so that a poor connection does not lose filing evidence.

- [x] Validate 250 MiB configurable size limit and initial allowlist: PDF, JPEG, PNG, DOCX, XLSX, CSV.
- [x] Create Graph upload sessions after application authorization.
- [x] Upload in 5 MiB resumable chunks and expose progress/retry state.
- [x] Complete idempotently and verify returned provider metadata before creating a document record.

### TD-407 — Protected document access — 4 points

**User story:** As an authorized staff member, I want to open a client document so that I can work without exposing it to unapproved users.

- [x] Require client/case/document permission before generating a download target.
- [x] Recheck deactivation and assignment permissions for every access request.
- [x] Record document-open audit events without logging document content.

### TD-408 — Document metadata and checklist links — 4 points

**User story:** As staff, I want to classify and verify a document so that it completes the correct case requirement.

- [x] Link document to client, optional case, type, upload actor, and optional checklist item.
- [x] Support pending, verified, rejected, and missing-provider verification states.
- [x] Update checklist progress only through verified required links.

### TD-409 — Soft delete and restore behavior — 3 points

**User story:** As a manager, I want accidental document removal to be recoverable.

- [x] Move provider object to trash and soft-delete application metadata.
- [x] Exclude deleted documents by default and retain audit history.
- [x] Permit documented restore only when the provider object remains recoverable.

### TD-410 — Provider reconciliation — 4 points

**User story:** As an operator, I want missing or externally changed files reported so that records and storage do not silently diverge.

- [x] Run an administrator-triggered reconciliation over stored external IDs.
- [x] Mark missing/moved files without deleting case history.
- [x] Report health, missing item count, and next action.

Criteria are checked off on local verification evidence: shared contract,
OneDrive adapter (mocked Graph), storage-connection and document route, role
matrix, web/axe, and PostgreSQL migration/repository suites, plus a
`/verify-epic` audit and re-audit (see the
[release note](../release-notes/epic-04-document-storage.md) and
[ADR 0006](../../adr/0006-provider-neutral-document-storage.md)). The OneDrive
adapter has not yet run against a real account outside the TD-005 spike. The
epic stays `in_progress` until a staging demonstration with a real OneDrive
connection and Sprint Review acceptance.

## Exit criteria

- No case or billing code imports Microsoft Graph directly.
- Only authorized application users can initiate upload or obtain document access.
- Interrupted uploads and revoked storage consent fail safely and visibly.

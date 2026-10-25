---
title: "Epic 4: Provider-Neutral Document Storage"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
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

- [ ] Define and test `DocumentStorageProvider` methods for connection, upload, completion, download, metadata, health, and trash.
- [ ] Implement an in-memory fake provider for service and route tests.
- [ ] Prevent domain services from importing Graph or OneDrive libraries.

### TD-402 — Storage connection data and token encryption — 4 points

**User story:** As an administrator, I want the storage connection protected so that staff never handle provider credentials.

- [ ] Store provider type, connection health, external drive/folder IDs, encrypted token payload, and key version.
- [ ] Encrypt/decrypt tokens using AES-GCM with deployment secrets stored outside source control and the database.
- [ ] Ensure tokens and provider authorization responses never reach browser logs or API responses.

### TD-403 — OneDrive administrator connection — 4 points

**User story:** As an administrator, I want to connect the firm OneDrive account once so that TaxDesk can store authorized documents.

- [ ] Begin delegated OAuth only for administrators.
- [ ] Validate callback state, complete consent, save connection metadata, and display health.
- [ ] Support reconnect and explicit disconnect with audit events.

### TD-404 — Token refresh and health checks — 3 points

**User story:** As an operator, I want OneDrive failures visible early so that document work is not silently lost.

- [ ] Refresh provider credentials atomically and retain rotation safety.
- [ ] Mark revoked/expired connection unhealthy and stop new document operations safely.
- [ ] Provide an administrator-only reconnect call to action.

### TD-405 — Stable storage layout — 3 points

**User story:** As the firm, I want documents organized by stable records so that client renames do not break access.

- [ ] Derive provider paths from stable client code, tax year, case ID, and document ID.
- [ ] Store external item ID and metadata as the durable reference.
- [ ] Reject unsafe filenames and unsupported content types before upload starts.

## Sprint 8 backlog — 20 points

### TD-406 — Resumable document upload — 5 points

**User story:** As staff, I want to upload a document reliably so that a poor connection does not lose filing evidence.

- [ ] Validate 250 MiB configurable size limit and initial allowlist: PDF, JPEG, PNG, DOCX, XLSX, CSV.
- [ ] Create Graph upload sessions after application authorization.
- [ ] Upload in 5 MiB resumable chunks and expose progress/retry state.
- [ ] Complete idempotently and verify returned provider metadata before creating a document record.

### TD-407 — Protected document access — 4 points

**User story:** As an authorized staff member, I want to open a client document so that I can work without exposing it to unapproved users.

- [ ] Require client/case/document permission before generating a download target.
- [ ] Recheck deactivation and assignment permissions for every access request.
- [ ] Record document-open audit events without logging document content.

### TD-408 — Document metadata and checklist links — 4 points

**User story:** As staff, I want to classify and verify a document so that it completes the correct case requirement.

- [ ] Link document to client, optional case, type, upload actor, and optional checklist item.
- [ ] Support pending, verified, rejected, and missing-provider verification states.
- [ ] Update checklist progress only through verified required links.

### TD-409 — Soft delete and restore behavior — 3 points

**User story:** As a manager, I want accidental document removal to be recoverable.

- [ ] Move provider object to trash and soft-delete application metadata.
- [ ] Exclude deleted documents by default and retain audit history.
- [ ] Permit documented restore only when the provider object remains recoverable.

### TD-410 — Provider reconciliation — 4 points

**User story:** As an operator, I want missing or externally changed files reported so that records and storage do not silently diverge.

- [ ] Run an administrator-triggered reconciliation over stored external IDs.
- [ ] Mark missing/moved files without deleting case history.
- [ ] Report health, missing item count, and next action.

## Exit criteria

- No case or billing code imports Microsoft Graph directly.
- Only authorized application users can initiate upload or obtain document access.
- Interrupted uploads and revoked storage consent fail safely and visibly.

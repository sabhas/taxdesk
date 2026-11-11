---
title: "Epic 2: Client Management"
status: in_progress
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-10
related:
  - ../roadmap.md
  - ../../technical/data-model.md
  - ../definition-of-done.md
---

# Epic 2: Client Management

## Scope

Deliver the protected client master record: individuals and businesses, contacts, assignment, search, duplicate handling, archive, and audit-safe activity.

**Out of scope:** tax cases, document uploads, client portal, fuzzy AI matching, and CSV import.

## Sprint 4 backlog — 21 points

### TD-201 — Client schema and validation — 3 points

**User story:** As staff, I want client records appropriate to an individual or business so that the firm has accurate master data.

- [x] Support client code, client type, legal/display name, encrypted CNIC/NTN, contacts, notes, assigned manager, and active/archive state.
- [x] Validate required fields by client type in shared schemas and server-side.
- [x] Generate stable client codes server-side.

### TD-202 — Create and view clients — 4 points

**User story:** As an authorized staff member, I want to create and view a client so that I can start managing their work.

- [x] Create a responsive client form with field-level validation and save feedback.
- [x] Show client summary, contacts, assignment, and safe activity history.
- [x] Restrict access by role and assignment rules.

### TD-203 — Update and concurrent edits — 3 points

**User story:** As staff, I want to update client details without silently overwriting a colleague’s change.

- [x] Require `If-Match`/ETag for client edits.
- [x] Return a conflict response for stale versions.
- [x] Present a refresh-and-review UI that preserves unsaved input for comparison.

### TD-204 — Search, filter, and pagination — 4 points

**User story:** As staff, I want to find clients quickly so that daily work does not depend on spreadsheets.

- [x] Search code, normalized name, phone, email, and exact blind-indexed identifier.
- [x] Filter by type, manager, and active/archive state.
- [x] Use cursor pagination and server-side filtering.
- [x] Provide empty and no-results states.

### TD-205 — Duplicate detection — 4 points

**User story:** As staff, I want duplicate warnings before creation so that the firm avoids split records.

- [x] Block exact identifier duplicates within the deployment.
- [x] Warn on matching email, phone, or high-confidence normalized name.
- [x] Allow only a manager or administrator to override non-exact warnings with a required reason.
- [x] Write override decisions to audit history.

### TD-206 — Archive and activity history — 3 points

**User story:** As a manager, I want to archive obsolete records without losing historical accountability.

- [x] Archive and restore clients with explicit confirmation.
- [x] Hide archived clients from default search and selection controls.
- [x] Mask sensitive field changes in activity and audit views.

## Implementation notes

- Contracts: `packages/shared/src/client.ts` (per-type Zod schemas, identifier,
  name, email, and phone normalization). Migration `0005_client_management.sql`.
- API: `packages/api/src/routes/clients.ts` → `domain/clients/client-service.ts`
  → `repositories/postgres-clients.ts` (and the in-memory double).
  `GET/POST /api/v1/clients`, `GET/PATCH /api/v1/clients/{id}`,
  `POST /api/v1/clients/{id}/archive|restore`, `GET /api/v1/clients/{id}/activity`,
  `POST /api/v1/clients/duplicate-check`, `GET /api/v1/clients/assignees`.
- CNIC/NTN are AES-256-GCM ciphertext plus an HMAC blind index and a masked
  form; the API never returns them unmasked
  ([ADR 0004](../../adr/0004-client-identifier-protection-and-visibility.md)).
- Visibility: `clients.read_all` (administrator, manager, billing, read-only)
  sees every client; consultants see clients they are the assigned manager of.
  Create, edit, archive, restore, and duplicate override need `clients.manage`.
- A stale `If-Match` returns `412 PRECONDITION_FAILED`, the conflict response
  used by every editable record; the edit form then shows the user's unsaved
  input beside the latest saved version.
- "Selection controls": no client picker exists yet. The list API hides
  archived clients unless `state` is set, so Epic 3 pickers inherit the rule.
- Tests: `packages/shared/src/client.test.ts`, `packages/api/src/routes/clients.test.ts`,
  `packages/api/src/crypto/identifier-protection.test.ts`, the client block in
  `packages/api/src/repositories/postgres.integration.test.ts`, and
  `packages/web/src/pages/clients/clients.test.tsx` (including axe checks).
- Release note: [Epic 2 release note](../release-notes/epic-02-client-management.md).
- Remaining for done: set `CLIENT_DATA_ENCRYPTION_KEY` and
  `CLIENT_IDENTIFIER_INDEX_KEY` in staging, apply migration `0005`,
  demonstrate the criteria on staging, and Sprint Review acceptance.

## Exit criteria

- A client can be created, searched, updated, archived, and restored by authorized users.
- Duplicate and stale-update behavior are tested.
- CNIC/NTN is encrypted at rest and never appears unmasked in logs.

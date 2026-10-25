---
title: "Epic 2: Client Management"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
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

- [ ] Support client code, client type, legal/display name, encrypted CNIC/NTN, contacts, notes, assigned manager, and active/archive state.
- [ ] Validate required fields by client type in shared schemas and server-side.
- [ ] Generate stable client codes server-side.

### TD-202 — Create and view clients — 4 points

**User story:** As an authorized staff member, I want to create and view a client so that I can start managing their work.

- [ ] Create a responsive client form with field-level validation and save feedback.
- [ ] Show client summary, contacts, assignment, and safe activity history.
- [ ] Restrict access by role and assignment rules.

### TD-203 — Update and concurrent edits — 3 points

**User story:** As staff, I want to update client details without silently overwriting a colleague’s change.

- [ ] Require `If-Match`/ETag for client edits.
- [ ] Return a conflict response for stale versions.
- [ ] Present a refresh-and-review UI that preserves unsaved input for comparison.

### TD-204 — Search, filter, and pagination — 4 points

**User story:** As staff, I want to find clients quickly so that daily work does not depend on spreadsheets.

- [ ] Search code, normalized name, phone, email, and exact blind-indexed identifier.
- [ ] Filter by type, manager, and active/archive state.
- [ ] Use cursor pagination and server-side filtering.
- [ ] Provide empty and no-results states.

### TD-205 — Duplicate detection — 4 points

**User story:** As staff, I want duplicate warnings before creation so that the firm avoids split records.

- [ ] Block exact identifier duplicates within the deployment.
- [ ] Warn on matching email, phone, or high-confidence normalized name.
- [ ] Allow only a manager or administrator to override non-exact warnings with a required reason.
- [ ] Write override decisions to audit history.

### TD-206 — Archive and activity history — 3 points

**User story:** As a manager, I want to archive obsolete records without losing historical accountability.

- [ ] Archive and restore clients with explicit confirmation.
- [ ] Hide archived clients from default search and selection controls.
- [ ] Mask sensitive field changes in activity and audit views.

## Exit criteria

- A client can be created, searched, updated, archived, and restored by authorized users.
- Duplicate and stale-update behavior are tested.
- CNIC/NTN is encrypted at rest and never appears unmasked in logs.

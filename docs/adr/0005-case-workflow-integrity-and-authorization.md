---
title: "ADR 0005: Tax-case workflow integrity and case authorization"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
related:
  - ../product/prd/epic-03-tax-case-workflow.md
  - ../technical/data-model.md
  - 0001-custom-identity-sessions-and-mfa.md
---

# ADR 0005: Tax-case workflow integrity and case authorization

Status is `proposed` until the Product Owner accepts Epic 3 in Sprint Review.

## Context

Epic 3 introduces configurable workflows and tax cases. Several of its
requirements change the security posture or a public contract:

1. TD-306 says status changes must be validated "atomically" and that direct
   status updates outside the transition command are rejected. The data model
   says status history is append-only.
2. TD-302/TD-303 require immutable published template versions, and the data
   model requires a case to keep a snapshot of the version it started with.
3. TD-301 needs someone to configure services and templates. No permission in
   the Epic 1 catalog covered firm configuration of case workflows.
4. Case routes must accept two read permissions (`cases.read_all`,
   `cases.read_assigned`) and two work permissions (`cases.manage`,
   `cases.work_assigned`), but a route policy could name only one permission.
5. TD-307 asks for preparer and reviewer responsibilities to be "clear".

## Decision

1. **Status changes only through a recorded transition.** A case row points at
   its current `case_status_history` row. A database trigger rejects any change
   to the status columns unless the case points at a new history row that
   belongs to the case, is its newest row, and records exactly that from/to
   change. History rows are append-only (the existing
   `taxdesk_reject_append_only_mutation` trigger). The API has no status field
   on case edits (the strict schema rejects one); `POST /cases/:id/transitions`
   is the only command.
2. **Checks run under a row lock.** Transitions, checklist actions, edits, and
   archive lock the case row (`SELECT … FOR UPDATE`) and re-check the version,
   state, allowed transition, and checklist gate inside the writing
   transaction. A stale `If-Match` returns `412`; a disallowed move returns
   `409 TRANSITION_NOT_ALLOWED` or `409 CHECKLIST_INCOMPLETE`.
3. **Snapshots and immutability.** Published `workflow_template_versions` rows
   cannot be updated or deleted (trigger). A case copies the service name and
   fee, the version's statuses and transitions, and its checklist items. A
   trigger rejects changes to those snapshot columns. Cases are never deleted;
   only completed or cancelled cases can be archived, and archived cases are
   read-only.
4. **New `services.manage` permission** for administrators and managers
   (migration `0006`). It configures service types and workflow templates.
   Everyone who can read cases can read the catalog.
5. **New `any_permission` route policy.** A route may declare a list of
   permissions; the guard passes when the actor holds at least one. The route
   registry test covers it for every role. Record-level rules still run in the
   domain service, using the existing Epic 1 assignment rule, where "assigned"
   means primary consultant or reviewer.
6. **Separation of preparer and reviewer.** The primary consultant (or a
   manager) completes and reopens items. The reviewer (or a manager) verifies
   or returns items that need review, never an item they completed themselves.
   A database check enforces `reviewed_by <> completed_by`. Assigning staff
   requires `cases.assign`. Without it, a consultant may open a case only for
   a client they manage, with themselves as primary consultant and no
   reviewer.
7. **Duplicate cases follow the service policy.** An open case for the same
   client, service, and tax year is either blocked (`409
   CASE_DUPLICATE_BLOCKED`) or warned (`409 CASE_DUPLICATE_WARNING`, overridable
   with an audited reason). Concurrent creates are serialized by locking the
   client row.

## Consequences

- Case history stays trustworthy even against a mistaken operator statement:
  the database itself refuses to rewrite status, snapshots, or history.
- Changing a published workflow means publishing a new version. Existing cases
  keep their version, so a later template change never alters work in flight.
- A filed, completed, or cancelled case locks its checklist; there is no
  reopen-after-filing path in this epic.
- Archive is one-way in this epic (no restore). A later epic can add a
  restore command if the firm needs one.
- `services.manage` must be granted through the role catalog. Migration `0006`
  seeds it, and the seed test keeps SQL and `ROLE_DEFINITIONS` in sync.

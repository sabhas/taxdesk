---
title: "Epic 3: Tax-Case Workflow"
status: in_progress
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
related:
  - ../roadmap.md
  - ../../technical/data-model.md
  - ../definition-of-done.md
---

# Epic 3: Tax-Case Workflow

## Scope

Deliver configurable service/workflow templates and case execution: assignments, deadlines, immutable status history, checklist verification, and work queues.

**Out of scope:** document file transfer, notifications, calendar synchronization, external filing submission, and workflow visual designer.

## Sprint 5 backlog — 20 points

### TD-301 — Service types — 3 points

**User story:** As an administrator, I want configurable services so that the application reflects the firm’s actual offerings without a code change.

- [x] Create, edit, archive, and list deployment-wide service types.
- [x] Store default fee, active state, and default deadline offset.
- [x] Preserve historical service values on existing cases.

### TD-302 — Workflow template versions — 5 points

**User story:** As a manager, I want reusable workflow templates so that comparable tax services follow a consistent process.

- [x] Define named statuses, allowed transitions, and which statuses require checklist completion.
- [x] Publish an immutable version rather than editing a published template in place.
- [x] Validate templates have one initial status and no unreachable active statuses.

### TD-303 — Checklist templates — 4 points

**User story:** As a manager, I want reusable checklist templates so that staff collect the correct information for each service.

- [x] Define ordered items, document type, required state, preparer/reviewer expectations, and instructions.
- [x] Publish checklist versions alongside workflow versions.
- [x] Preserve existing case items when a new template version is published.

### TD-304 — Create a tax case — 5 points

**User story:** As staff, I want to open a tax case from a client so that work, due dates, and responsibility are visible.

- [x] Require client, service, tax year, workflow version, and due date.
- [x] Copy status and checklist template snapshots into the new case.
- [x] Warn or block duplicate active client/service/tax-year cases according to service policy.
- [x] Assign primary consultant and optional reviewer.

### TD-305 — Case details and draft editing — 3 points

**User story:** As assigned staff, I want to update a draft case so that context remains current.

- [x] Show case summary, assignees, deadlines, current status, and checklist progress.
- [x] Require ETag for edits and record audit events.
- [x] Enforce assignment and permission rules.

## Sprint 6 backlog — 19 points

### TD-306 — Server-validated status transitions — 4 points

**User story:** As staff, I want to move a case through allowed stages so that filing progress is trustworthy.

- [x] Validate current state, allowed transition, permission, and required checklist conditions atomically.
- [x] Record immutable old/new status, actor, note, and timestamp.
- [x] Reject direct status updates outside the transition command.

### TD-307 — Checklist completion and review — 4 points

**User story:** As a consultant and reviewer, I want to complete and verify checklist items separately so that review responsibility is clear.

- [x] Allow preparer completion/reopen and reviewer verification/rejection with comments.
- [x] Show required/complete/verified counts.
- [x] Prevent Filed or Completed transition while required items are incomplete or unverified.

### TD-308 — Assignment and workload queues — 4 points

**User story:** As a manager, I want queues by staff member and urgency so that work can be balanced.

- [x] Provide My Work, team, unassigned, due soon, and overdue case views.
- [x] Filter by service, status, assignee, reviewer, and tax year.
- [x] Calculate counts from the same server-side query used by the list.

### TD-309 — Case history and safe archive — 3 points

**User story:** As a manager, I want an understandable case history so that decisions can be reviewed later.

- [x] Display status, assignment, and material-edit history chronologically.
- [x] Archive only completed or cancelled cases after confirmation.
- [x] Retain all status history and document metadata after archive.

### TD-310 — Workflow concurrency and tests — 4 points

**User story:** As the firm, I want concurrent edits and transitions to fail safely so that case history remains accurate.

- [x] Test simultaneous edit, status transition, and checklist verification scenarios.
- [x] Return HTTP 412 for stale ETags and domain errors for invalid transitions.
- [x] Add browser tests for a case from creation through completion.

Criteria are checked off on local verification evidence: shared, API route, role
matrix, web/axe, and PostgreSQL migration/repository suites (see the
[release note](../release-notes/epic-03-tax-case-workflow.md) and
[ADR 0005](../../adr/0005-case-workflow-integrity-and-authorization.md)). The
TD-310 browser tests run the full React app in jsdom. The epic stays
`in_progress` until a staging demonstration and Sprint Review acceptance.

## Exit criteria

- A manager can configure a service workflow and checklist.
- Staff can run a case through the approved workflow without bypassing server validation.
- Users can see current work, urgent work, and accountable history.

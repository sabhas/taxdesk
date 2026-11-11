---
title: "Release note: Epic 3 tax-case workflow"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
related:
  - ../prd/epic-03-tax-case-workflow.md
  - ../../adr/0005-case-workflow-integrity-and-authorization.md
  - ../../technical/data-model.md
---

# Release note: Epic 3 tax-case workflow (TD-301–TD-310)

Draft until staging demonstration and Sprint Review acceptance.

## What users can do

- **Services** (administrators and managers): create, edit, archive, and
  restore the firm's services, each with a default fee (PKR), a default
  deadline in days, a duplicate-case policy (warn or block), and a default
  workflow. Archived services stay listed under "Archived" and keep their
  cases.
- **Workflows** (administrators and managers): build reusable templates with
  named statuses, allowed transitions, and an ordered checklist (document type,
  required, reviewer must verify, instructions). The editor flags problems as
  you type, such as no single initial status, a status that cannot be reached,
  or a dead end. Publishing freezes a version; later changes go into a new
  draft. Cases keep the version they were opened with. New templates start
  from a typical annual-return workflow.
- **Open a case** from the Cases page or from a client's page. Choose the
  client, service, tax year, workflow version, due date (pre-filled from the
  service), primary consultant, and an optional reviewer. A second open case
  for the same client, service, and tax year is blocked or needs a written
  reason, depending on the service. Consultants open cases for clients they
  manage, with themselves as primary consultant; managers assign anyone.
- **Work queues**: My work, Team, Unassigned, Due soon (within 7 days),
  Overdue, Closed, and Archived. Each shows a count. Filter by service, status,
  primary consultant, reviewer, and tax year. Counts and lists come from the
  same server query, and due dates use the firm calendar.
- **Case page**: summary, assignees, due date with an overdue/due-soon flag,
  fee and workflow version, status with the allowed next steps, and the
  checklist with required/completed/verified counts. Moves that the checklist
  blocks say why.
- **Checklist**: the primary consultant completes or reopens items. The
  reviewer verifies them or returns them with a comment. Nobody verifies their
  own work. Filed and Completed need every required item complete, and
  verified where review is required. The checklist locks once a case is filed.
- **History**: a permanent status history (who moved it, when, and the note)
  and an activity list of edits, assignment changes, checklist decisions, and
  archive.
- **Archive** completed or cancelled cases after a confirmation. They leave
  the queues and become read-only, and their history is kept.
- If a colleague changed the case first, the page explains the conflict and
  reloads the latest version instead of overwriting it.

## Data changes

- Migration `0006_tax_case_workflow.sql` (forward-only): tables
  `service_types`, `workflow_templates`, `workflow_template_versions`,
  `tax_cases`, `case_status_history`, `case_checklist_items`; sequence
  `tax_case_code_seq`; permission `services.manage` granted to administrator and
  manager; triggers that keep published versions, case snapshots, and status
  history immutable and allow status changes only through recorded
  transitions.
- No existing rows are changed.
- New API under `/api/v1`: `service-types`, `workflow-templates` (with
  `versions` and `publish`), and `cases` (list, `queue-counts`, `assignees`,
  create, view, edit, `transitions`, `status-history`, `activity`, `archive`,
  and `checklist/:itemId/{complete,reopen,verify,reject}`).

## Operational actions

1. Apply migration `0006` before deploying the API (`pnpm db:migrate`, run by
   the staging delivery workflow). No new secrets are needed.
2. After deploying, a manager signs in, creates and publishes a workflow, then
   creates a service that uses it. Cases cannot be opened until both exist.
3. Use synthetic client data only until TD-709 and TD-710 pass.

## Known limitations

- The new-case client picker lists the first 100 active clients (plus a client
  chosen from its own page). Firms with more clients should open cases from
  the client's page until a searchable picker is added.
- Archive has no restore, and the checklist cannot be reopened after filing
  (see ADR 0005).
- Browser tests run the full React app in jsdom against a stateful fake API,
  like the Epic 2 web tests. The repository has no real-browser (Playwright)
  run yet; the staging demonstration covers the real browser.

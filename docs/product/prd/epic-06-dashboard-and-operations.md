---
title: "Epic 6: Dashboard and Operations"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - ../roadmap.md
  - ../../technical/architecture.md
  - ../definition-of-done.md
---

# Epic 6: Dashboard and Operations

## Scope

Deliver role-aware dashboards, server-side operational reports, CSV export, audit exploration, and organization settings.

**Out of scope:** email/SMS/WhatsApp reminders, external BI dashboards, scheduled reports, custom report builder, and advanced accounting analytics.

## Sprint 11 backlog — 20 points

### TD-601 — Role-aware dashboard summary — 5 points

**User story:** As a staff member, I want a dashboard relevant to my responsibilities so that I know what needs attention today.

- [ ] Show assigned cases, overdue/due-soon cases, checklist gaps, and filing progress for consultants.
- [ ] Add unassigned work, team workload, and review queue for managers.
- [ ] Add unpaid invoices and monthly collection summary for billing/management roles.
- [ ] Reuse server-side query definitions so displayed counts reconcile with lists.

### TD-602 — Case and workload reports — 4 points

**User story:** As a manager, I want to filter case and staff workload reports so that I can allocate work and manage deadlines.

- [ ] Filter by date range, service, status, staff member, tax year, and active/archive state.
- [ ] Use cursor pagination and server-side filtering.
- [ ] Permit CSV export only to roles with report permission.

### TD-603 — Billing reports — 4 points

**User story:** As a manager, I want collection and outstanding reports so that I can follow up on unpaid work.

- [ ] Report invoice totals, payments, reversals, outstanding balances, and overdue invoices by date range.
- [ ] Ensure report totals use the same financial calculation service as invoice detail.
- [ ] Include zero-result and inaccessible-data states.

### TD-604 — Audit explorer — 3 points

**User story:** As an administrator, I want searchable audit history so that I can investigate important changes.

- [ ] Filter by actor, date range, action, entity type, entity ID, and request ID.
- [ ] Display masked changes and correlation information only.
- [ ] Deny audit access to non-administrators.

### TD-605 — Organization settings and accessibility pass — 4 points

**User story:** As an administrator, I want firm settings controlled in the app so that deployment configuration is not used for ordinary business choices.

- [ ] Manage firm name, timezone, currency, invoice/receipt prefix, document-size limit, and dashboard deadline windows.
- [ ] Audit setting changes and validate safe ranges.
- [ ] Verify dashboard/report critical paths for keyboard navigation, contrast, focus, and responsive layout.

## Exit criteria

- Every dashboard total can be traced to an authorized report/list query.
- Reports never return another organization’s data.
- Administrators can investigate material actions without seeing secrets or unmasked identifiers.

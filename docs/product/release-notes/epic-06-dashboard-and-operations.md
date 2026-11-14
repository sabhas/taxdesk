---
title: "Release note: Epic 6 dashboard and operations"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - ../prd/epic-06-dashboard-and-operations.md
  - ../../adr/0008-dashboard-reports-and-firm-settings.md
  - ../../technical/data-model.md
---

# Release note: Epic 6 dashboard and operations (TD-601–TD-605)

Draft until staging demonstration and Sprint Review acceptance.

## What users can do

- **Dashboard** (everyone with dashboard access): consultants see cases assigned to
  them, overdue and due-soon cases, cases with checklist gaps, and filing
  progress. Managers and administrators also see unassigned work, the review
  queue, and open, overdue, due-soon, and reviewing counts per staff member.
  Billing, manager, read-only, and administrator roles see unpaid and overdue
  invoices and this month's net collections. Every figure is a link to the list
  or report with exactly those rows.
- **Reports** (roles with report access): a case report filtered by due-date
  range, service, status, staff member, tax year, and active/archived; a staff
  workload report; and a billing report of invoiced, collected, reversed,
  outstanding, and overdue amounts for a date range. Reports are paged
  and can be exported to CSV. Exports are recorded in the audit history.
- **Audit history** (administrators): search by actor, date range, action
  (`billing.*` works), entity type and ID, and request ID. Secrets and national
  identifiers are masked.
- **Firm settings** (administrators edit; others view): firm name, timezone,
  currency (PKR), invoice and receipt prefixes, document size limit, and the
  due-soon window. Changes are audited with old and new values.

## Roles

| Role | Dashboard | Case and workload reports | Billing report | CSV export | Audit history | Edit settings |
| --- | --- | --- | --- | --- | --- | --- |
| Administrator | all sections | yes | yes | yes | yes | yes |
| Manager | all sections | yes | yes | yes | no | no |
| Billing | cases and billing | yes | yes | yes | no | no |
| Read-only | cases and billing | yes | yes | yes | no | no |
| Consultant | own cases | no | no | no | no | no |

## Data changes

- Migration `0009_dashboard_and_operations.sql` adds five settings columns to
  `firm_settings` (with database range checks), relaxes the invoice and receipt
  number checks to any 2–6 letter prefix, and adds report and audit indexes.
  Existing numbers and the immutability triggers are unchanged.
- A new prefix applies only to numbers issued after the change.

## Operational actions

- Apply migration `0009` in staging. No new secrets.
- `DOCUMENT_MAX_UPLOAD_BYTES` is now a ceiling. The administrator sets the
  working limit in Firm settings; the effective limit is the lower of the two.
- Integrations that call `GET /api/v1/admin/audit-events` now receive
  `actorDisplayName` and masked metadata, and unknown query parameters are
  rejected with 400.
- Not included: scheduled reports, a custom report builder, reminders, external
  BI, and currencies other than PKR.

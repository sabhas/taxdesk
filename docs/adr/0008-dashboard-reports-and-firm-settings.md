---
title: "ADR 0008: Reconciled dashboards, permissioned reports, and firm settings"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - ../product/prd/epic-06-dashboard-and-operations.md
  - ../technical/data-model.md
  - ./0005-case-workflow-integrity-and-authorization.md
  - ./0007-billing-integrity-and-idempotency.md
---

# ADR 0008: Reconciled dashboards, permissioned reports, and firm settings

Status is `proposed` until the Product Owner accepts Epic 6 in Sprint Review.

## Context

Epic 6 shows aggregates and exports data. Its exit criteria are that every
dashboard total can be traced to an authorized list or report, that reports
enforce the requester's permissions, and that administrators can investigate
actions without seeing secrets or unmasked identifiers.

## Decisions

1. **One query definition per figure.** The dashboard does not run its own
   aggregates for cases. It builds the same `CaseQueryFilter` the case list
   uses (`CaseService.filterFor`) and calls `cases.count`. Each figure carries
   an `href` to the list or report that returns those rows, and a route test
   opens every link and compares the list total with the figure.
2. **Scope comes from the actor.** The assignment restriction for consultants
   is derived from permissions inside `filterFor`; no request supplies a scope.
   Dashboard sections appear only for the permissions that justify them. Case
   and workload reports need `reports.read` plus a case-read permission; billing
   reports need `reports.read`, `billing.read`, and visibility of every client's
   invoices, otherwise the API answers 403 and the UI shows an inaccessible-data
   state.
3. **Billing totals reuse the stored calculation.** Report totals sum the
   `total_minor` and `outstanding_minor` the billing service wrote with the
   shared totals calculator; they never recompute a balance. Report rows come from
   the invoice list. A test checks every row and the outstanding total against
   invoice detail.
4. **CSV export is audited and injection-safe.** Exports are `GET` requests
   gated by `reports.read`, capped at 10,000 rows (a header reports truncation),
   neutralize cells that start with `=`, `+`, `-`, `@`, tab, or CR, and append a
   `report.exported` audit event with the report, row count, and filters.
5. **Audit explorer masks on the way out.** `audit.read` (administrators only)
   searches by actor, date range, action, entity, and request ID. Metadata is
   masked by key (token, secret, password, hash, identifier, CNIC/NTN) and by
   value shape (national identifier, long opaque strings) before it reaches the
   response, so a mistake at write time still cannot leak.
6. **Business settings live in `firm_settings`.** Currency, invoice and receipt
   prefix, the document size limit, and the due-soon window are database-checked
   settings with audited changes. Deployment configuration keeps only a ceiling for
   the upload limit. Currency is limited to PKR until invoices support more.
   Prefix changes affect future numbers only, so the gapless sequence and
   immutable issued numbers are untouched.

## Consequences

- The dashboard issues several count queries per request (about a dozen per
  role plus four per staff member). That is fine for a single-firm deployment;
  a materialized summary can replace it without changing the contract.
- Counts read at slightly different instants, so a figure can differ from a list
  opened a moment later if work changed in between. Both come from the same
  predicate.
- Not included: scheduled reports, a report builder, reminders, and external BI.

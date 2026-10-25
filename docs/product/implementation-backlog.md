---
title: TaxDesk implementation backlog
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - roadmap.md
  - definition-of-done.md
  - status.md
---

# TaxDesk implementation backlog

Implement in this order. Story points are relative sizing for one experienced engineer; they are planning inputs, not elapsed-time promises.

| Sprint | Stories | Points | Dependencies | Unlocks |
| --- | --- | ---: | --- | --- |
| 1 | TD-001–TD-006 | 20 | — | All product work; document-provider decision |
| 2 | TD-101–TD-106 | 20 | TD-001–TD-004 | Role- and permission-based secure access |
| 3 | TD-107–TD-111 | 19 | Sprint 2 | User lifecycle, MFA, permissions, protected routes |
| 4 | TD-201–TD-206 | 21 | Sprint 3 | Cases, documents, billing, imports |
| 5 | TD-301–TD-305 | 20 | Sprint 4 | Configurable case workflow |
| 6 | TD-306–TD-310 | 19 | Sprint 5 | Operational case execution and dashboard inputs |
| 7 | TD-401–TD-405 | 18 | TD-005, Sprint 3 | Provider-neutral document domain |
| 8 | TD-406–TD-410 | 20 | Sprint 7, Sprint 6 | Full document workflow |
| 9 | TD-501–TD-505 | 20 | Sprint 3, Sprint 6 | Finalized invoices and invoice documents |
| 10 | TD-506–TD-510 | 19 | Sprint 9 | Payments, receipts, balance reporting |
| 11 | TD-601–TD-605 | 20 | Sprints 4–10 | Operational dashboard and reports |
| 12 | TD-701–TD-705 | 19 | Sprints 4–11 | Safe data import |
| 13 | TD-706–TD-710 | 18 | Sprint 12 | Production release candidate |
| 14 | TD-801–TD-805 | 19 | Sprint 13 | Production launch |

## Engineering build order

Within every story, build in this order unless the PRD says otherwise:

`shared schemas/types → domain service → repository/migration → API → web feature → tests → documentation`

Domain services own business rules. Route handlers coordinate request validation, authorization, idempotency, and responses. React components never calculate financial balances, enforce workflow transitions, or decide permissions.

## Dependency rules

- Do not begin case, document, billing, or import work before authorization is passing automated tests.
- Do not begin production OneDrive work before TD-005 records a successful Personal-account proof of concept.
- Do not expose a document upload, invoice finalization, payment, or import commit route without idempotency coverage.
- Do not load real client data before TD-709 restore rehearsal and TD-710 security review pass.

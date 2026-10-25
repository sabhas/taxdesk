---
title: TaxDesk implementation roadmap
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - implementation-backlog.md
  - status.md
---

# TaxDesk implementation roadmap

This roadmap converts the original nine broad delivery phases into 14 two-week, capacity-sized sprints. It assumes one experienced full-time engineer and a target of roughly 18–22 story points per sprint. Re-plan after Sprint 1 using observed velocity; never reduce security, data-integrity, or recovery requirements to preserve a date.

## Release phases

| Phase | Sprints | Release outcome |
| --- | --- | --- |
| Foundation | 1 | Deployable staging skeleton; OneDrive Personal feasibility proved |
| Secure core | 2–4 | Secure user access and client master data |
| Case operations | 5–6 | Cases, workflow, checklists, and staff queues |
| Documents and finance | 7–10 | OneDrive documents, invoices, payments, and receipts |
| Operations and readiness | 11–13 | Reporting, migration, security, backup, and recovery |
| Pilot and launch | 14 | Controlled production launch |

## Sprint schedule

| Sprint | Goal | Points | Demonstrable increment |
| --- | --- | ---: | --- |
| 1 | Foundation and platform proof | 20 | Staging app, migrations, CI, tested OneDrive proof of concept |
| 2 | Authenticated organization foundation | 20 | Bootstrap, login/logout, secure sessions, membership scope |
| 3 | MFA and authorization hardening | 19 | MFA, user lifecycle, server-enforced permissions |
| 4 | Client master data | 21 | Protected client CRUD, search, duplicate detection |
| 5 | Workflow configuration and cases | 20 | Service templates and draft cases |
| 6 | Case execution | 19 | Transitions, checklist verification, queues, conflict handling |
| 7 | Storage connection platform | 18 | Provider contract, encrypted OneDrive connection, health checks |
| 8 | Document workflow | 20 | Resumable upload, protected download, checklist links, reconciliation |
| 9 | Invoice lifecycle | 20 | Draft/final invoices, invoice PDFs, numbering, audit trail |
| 10 | Payment lifecycle | 19 | Partial payments, receipts, reversals, balances |
| 11 | Operations visibility | 20 | Dashboard, reports, audit explorer, organization settings |
| 12 | Controlled data import | 19 | CSV templates, dry-run validation, idempotent commit |
| 13 | Recovery and release candidate | 18 | Migration rehearsal, backup/restore, security review |
| 14 | Pilot and production launch | 19 | User acceptance, failure drills, production migration, training |

## Sprint rules

- A Sprint Goal is more important than finishing every optional story; preserve the goal and return unfinished work to refinement.
- Only stories listed in the sprint backlog are in scope. New requests are prioritized for a future sprint unless they prevent the current goal.
- A sprint review happens against staging using representative data and named user roles.
- An epic is complete only after all stories, acceptance criteria, and Definition of Done checks are complete.

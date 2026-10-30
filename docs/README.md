---
title: TaxDesk documentation
status: accepted
version: 1.0
last_reviewed: 2026-10-25
---

# TaxDesk documentation

Start here for the TaxDesk product plan, technical boundaries, and delivery workflow.

## Documentation map

```text
docs/
  README.md                         # This index
  taxdesk-implementation-plan.md    # Approved architecture and release plan
  product/
    README.md                       # Product-document index
    roadmap.md                      # Releases and sprint sequence
    implementation-backlog.md       # Ordered, dependency-aware backlog
    implementation-workflow.md      # Mandatory read order and scope rules
    definition-of-done.md           # Shared completion standard
    status.md                       # Live implementation status
    prd/                            # One execution-ready PRD per epic
  technical/
    architecture.md                 # Modules, interfaces, security boundaries
    data-model.md                   # Domain model and invariants
    environments.md                 # Environment isolation, Hyperdrive, deployment, health checks
  adr/                              # Immutable architecture decisions
.pi/
  settings.json                     # Pi agent project configuration
  prompts/                          # Pi slash-command prompts for implementation and verification
```

## How to use this documentation

1. Read [the implementation plan](taxdesk-implementation-plan.md) for the approved product and architecture decisions.
2. Select the next item in [the implementation backlog](product/implementation-backlog.md).
3. Read its epic PRD under [`product/prd`](product/prd/README.md), then the linked technical documents.
4. Run the matching Pi slash command from [`.pi/prompts`](../.pi/prompts) (for example `/implement-story`) and implement only the stories assigned to the current sprint.
5. Verify every acceptance criterion and the shared [Definition of Done](product/definition-of-done.md).
6. Update [implementation status](product/status.md) and check off completed acceptance criteria.

## Epic index

| Epic | Sprint(s) | Document | Outcome |
| --- | --- | --- | --- |
| 0 | 1 | [Foundation and platform validation](product/prd/epic-00-foundation-and-platform.md) | Deployable skeleton and proven OneDrive integration |
| 1 | 2–3 | [Identity, MFA, and authorization](product/prd/epic-01-identity-mfa-and-authorization.md) | Secure firm access and role enforcement |
| 2 | 4 | [Client management](product/prd/epic-02-client-management.md) | Searchable, protected client master data |
| 3 | 5–6 | [Tax-case workflow](product/prd/epic-03-tax-case-workflow.md) | Configurable cases, status, checklists, and queues |
| 4 | 7–8 | [Document storage](product/prd/epic-04-document-storage.md) | Provider-neutral documents using OneDrive |
| 5 | 9–10 | [Billing and payments](product/prd/epic-05-billing-and-payments.md) | Immutable invoices, payments, and receipts |
| 6 | 11 | [Dashboard and operations](product/prd/epic-06-dashboard-and-operations.md) | Operational visibility, reports, and audit review |
| 7 | 12–13 | [Migration, security, and recovery](product/prd/epic-07-migration-security-and-recovery.md) | Trusted import and proven recovery |
| 8 | 14 | [Pilot and production launch](product/prd/epic-08-pilot-and-production-launch.md) | Measured, supportable production release |

## Documentation rules

- Epic PRDs own user stories and acceptance criteria.
- Technical documents own architecture, data contracts, and invariants.
- ADRs record irreversible decisions; create a new ADR to supersede one.
- The status file is updated whenever an epic or story starts or finishes.
- Never mark a story done merely because code compiles; apply the Definition of Done.

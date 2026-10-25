---
title: TaxDesk implementation workflow
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - implementation-backlog.md
  - definition-of-done.md
  - status.md
  - prompts/
---

# TaxDesk implementation workflow

Use one chat per story by default. Use one epic per chat only when the epic has no cross-cutting risk and the implementation context remains manageable.

## Mandatory read order

1. Repository `AGENTS.md`, if present.
2. The current epic PRD in `docs/product/prd/`.
3. [Implementation backlog](implementation-backlog.md) and [status](status.md).
4. Relevant documents in `docs/technical/`.
5. [Definition of Done](definition-of-done.md).

## Build order

```text
shared schemas/types → domain service → repository/migration → API → web feature → tests → documentation
```

- Do not place authorization, workflow, or financial rules in React components.
- Do not let routes calculate invoice balances or directly query OneDrive.
- Do not let a request choose its own `organization_id`; derive it from the authenticated membership.
- Do not mutate finalized invoices, payments, reversals, or case status history.
- Use optimistic concurrency for editable records and idempotency for financial, import, and upload-completion commands.

## Scope rules

- Implement only the story or epic named in the prompt.
- Treat unlisted product ideas as backlog candidates, not implicit scope.
- Keep OneDrive access behind `DocumentStorageProvider`.
- Do not use real client data in development, tests, fixtures, or screenshots.
- Do not mark a story done until all acceptance criteria and applicable Definition of Done items pass.

## After implementation

1. Run type check, lint, unit tests, relevant integration tests, and browser tests.
2. Use the verification prompt to audit acceptance criteria.
3. Check off verified criteria in the epic PRD.
4. Update `docs/product/status.md` and any affected technical documents.
5. Add or supersede an ADR for a decision that changes security posture, tenancy, cost, or public contract.

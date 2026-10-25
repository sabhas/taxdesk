---
title: "Epic N: Title"
status: draft
version: 0.1
owners: [product, engineering]
last_reviewed: YYYY-MM-DD
related:
  - ../roadmap.md
  - ../../technical/architecture.md
  - ../definition-of-done.md
---

# Epic N: Title

## Scope

State the product outcome, included behavior, and explicit exclusions.

## Dependencies

- Prior epic/story IDs:
- Required technical decision or external proof:

## Sprint N backlog — N points

### TD-NNN — Story title — N points

**User story:** As a …, I want … so that …

- [ ] Observable acceptance criterion.
- [ ] Authorization, validation, and failure behavior where relevant.
- [ ] Required test or operational evidence.

## Analytics and audit events

- `domain.action` — when it is emitted and which non-sensitive fields it contains.

## Implementation notes

| Area | Expected change |
| --- | --- |
| Shared contracts | DTOs, Zod schemas, error codes |
| Domain service | Business rules and invariants |
| Persistence | Tables, migration, indexes |
| API | Endpoint and authorization |
| Web | Feature route, loading/error/empty states |
| Tests | Unit, integration, browser, contract |

## Exit criteria

- Conditions that prove the epic is ready for the next dependency or release gate.

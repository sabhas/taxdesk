# TaxDesk contributor guide

TaxDesk is in planning state: Sprint 1 has not started and this repository currently
contains the approved product and architecture documentation, not an application
workspace. Treat the documentation as the source of truth until implementation
artifacts are introduced.

## Start here

Before changing product or implementation work, read these documents in order:

1. `docs/product/prd/epic-00-foundation-and-platform.md` (or the PRD for the
   assigned epic)
2. `docs/product/implementation-backlog.md`
3. `docs/product/status.md`
4. Relevant files in `docs/technical/`
5. `docs/product/definition-of-done.md`

`docs/product/implementation-workflow.md` defines the mandatory delivery order
and scope rules. Implement only the story or epic assigned to the task.

Pi slash commands in `.pi/prompts/` carry these rules and the required read order.
Prefer them over hand-written prompts:

| Command | Arguments | Use when |
| --- | --- | --- |
| `/implement-story` | `<story-id> <epic-prefix> <epic-slug>` | Implementing one story as a vertical slice |
| `/implement-epic` | `<epic-prefix> <epic-slug> [epic-title]` | An entire epic is approved for one effort |
| `/implement-sprint` | `<sprint-number> [goal] [story-ids...]` | Running a committed sprint backlog |
| `/verify-story` | `<story-id> <epic-prefix> <epic-slug>` | Auditing one story against its criteria |
| `/verify-epic` | `<epic-prefix> <epic-slug> [epic-title]` | Auditing a completed epic for release |

`<epic-prefix>` is the zero-padded PRD prefix, so `/implement-story TD-001 00
foundation-and-platform` targets `docs/product/prd/epic-00-foundation-and-platform.md`.

These commands expand from `.pi/prompts/*.md` after project trust is granted. Run
`/reload` after editing a prompt. Verification commands audit only; they do not
implement fixes unless explicitly requested afterwards.

## Current implementation baseline

- Start with Epic 0 / Sprint 1. Do not assume a frontend, API, workspace tooling,
  package manager configuration, or test command already exists.
- The intended application is a pnpm workspace modular monolith: React/Vite web,
  Hono Worker API, shared TypeScript/Zod contracts, Drizzle/PostgreSQL, and test
  utilities.
- Once tooling exists, use the repository-defined install, format, lint,
  type-check, unit, integration, and browser-test commands. Do not invent commands
  in documentation; add or update them when TD-001 establishes the workspace.
- Keep changes scoped. Do not begin later epics to satisfy an unlisted idea.

## Architecture rules (non-negotiable)

- One deployment serves exactly one firm. Do not add `organization_id` to business
  records or client-controlled authorization scope.
- Keep business rules in domain services, data access in repositories, transport
  parsing/response mapping in API routes, and presentation in web features.
- The browser never connects directly to PostgreSQL or OneDrive/Microsoft Graph.
  Use the authenticated Worker API and the `DocumentStorageProvider` abstraction.
- Validate shared API inputs, outputs, and errors with Zod. API endpoints live
  under `/api/v1`, return Problem Details errors, and use cursor pagination.
- Enforce authorization from authenticated roles and permissions on the server.
  Never trust a role, scope, owner, or permission supplied by the request.
- Require request IDs for mutations, append audit events for material changes, and
  use ETags/`If-Match` for editable records. Financial, import, and upload-
  completion commands must be idempotent.

## Data and security rules

- Use UUIDv7 IDs, UTC timestamps, integer minor currency units, and integer
  `version` columns. Present dates in the configured firm timezone (`Asia/Karachi`
  initially).
- Use forward-only, versioned SQL migrations; never edit a migration after it has
  been applied. Test migrations against a clean database.
- Do not use real client data in source, fixtures, tests, screenshots, logs, or
  local/staging databases. Never expose secrets, tokens, hashes, encryption keys,
  document contents, or unmasked national tax identifiers.
- Preserve immutability: case-status history and audit events are append-only;
  finalized invoices, payments, and reversals are never edited or deleted. Reverse
  payments with linked reversal entries.
- Keep provider tokens encrypted and inside deployment secrets. Store
  provider-neutral document identifiers, never OneDrive paths in business logic.

## Documentation and completion

- Epic PRDs own stories and acceptance criteria; technical documents own data
  contracts and invariants. ADRs are immutable—add a superseding ADR instead of
  rewriting an accepted decision.
- When implementation starts or finishes, update `docs/product/status.md`; check
  off verified PRD acceptance criteria and update affected technical/runbook docs.
- A story is not complete because it compiles. Meet every applicable item in
  `docs/product/definition-of-done.md`, including authorization coverage,
  accessibility, concurrency/error states, observability, and staging validation.
- Run `/verify-story` or `/verify-epic` before checking off acceptance criteria;
  claim completion only with evidence from the current codebase.

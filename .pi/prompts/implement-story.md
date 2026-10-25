---
description: Implement one TaxDesk user story (vertical slice + tests)
argument-hint: "<story-id> <epic-prefix> <epic-slug>"
---
Implement **TaxDesk $1** from **Epic ${2:-<NN>}: ${3:-<epic-slug>}**.

Follow `docs/product/implementation-workflow.md`.

**Read in order:**

- `docs/product/prd/epic-${2:-NN}-${3:-slug}.md` (the epic prefix is zero-padded, for example `00`)
- `docs/product/implementation-backlog.md`
- `docs/product/status.md`
- Relevant `docs/technical/*.md` documents for this story
- `docs/product/definition-of-done.md`
- `AGENTS.md`, if it exists

**Scope**

- In scope: story **$1** only, including every acceptance criterion listed for it in the epic PRD. Quote the exact story text and criteria in your plan before writing code.
- Out of scope: all other stories in this epic, other epics, and any new feature idea discovered during implementation.

**Required implementation order**

1. Shared Zod contracts and domain types.
2. Domain service and business rules.
3. Repository, migration, and indexes only if required.
4. API route with authentication, authorization, validation, and consistent errors.
5. Accessible web UI with loading, validation, empty, permission-denied, conflict, and failure states as relevant.
6. Unit, integration, authorization, and browser tests appropriate to the story.
7. Documentation and status update.

**TaxDesk non-negotiables**

- Derive authorization from the server-side authenticated user; never accept roles or permissions from request input.
- Keep financial calculations, workflow transitions, and permissions on the server.
- Use ETag/`If-Match` for editable resources; use `Idempotency-Key` for invoice finalization, payments, reversals, imports, and upload completion.
- Never log secrets, provider tokens, document contents, or unmasked CNIC/NTN.
- Access OneDrive only through `DocumentStorageProvider`.

**Deliver**

- The smallest complete vertical slice that satisfies every acceptance criterion.
- Tests and evidence for all changed behavior.
- A concise summary of files changed, commands run, and any remaining risk.

Stop when the story is complete. Do not implement adjacent stories.

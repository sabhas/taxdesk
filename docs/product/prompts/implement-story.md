# Prompt: Implement one TaxDesk user story

Copy this into a new implementation chat. Replace every placeholder and attach the referenced files.

---

Implement **TaxDesk {story ID}: {story title}** from **Epic {N}: {epic title}**.

Follow @docs/product/implementation-workflow.md.

**Read in order:**

- @docs/product/prd/epic-{NN}-{slug}.md
- @docs/product/implementation-backlog.md
- @docs/product/status.md
- @{relevant `docs/technical/*.md` documents}
- @docs/product/definition-of-done.md
- @AGENTS.md, if it exists

**Scope**

- In scope: {paste the exact story and its acceptance criteria}
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

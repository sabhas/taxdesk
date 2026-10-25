# Prompt: Verify a TaxDesk epic

Use after all stories in an epic are believed complete. This is an audit only; do not implement fixes unless explicitly requested.

---

Audit the current codebase against **TaxDesk Epic {N}: {title}**.

**Read:**

- @docs/product/prd/epic-{NN}-{slug}.md
- @docs/product/implementation-backlog.md
- @docs/technical/architecture.md
- @docs/technical/data-model.md
- @docs/product/definition-of-done.md
- @docs/product/status.md
- @AGENTS.md, if it exists

**Output exactly:**

1. Story-by-story table: story ID, acceptance criteria met/total, status (`met`, `partial`, `missing`), and evidence paths.
2. Cross-story audit: schema/migration integrity, authorization, audit events, error states, accessibility, and tests.
3. Applicable Definition of Done table.
4. Release blockers, ordered by severity, with the smallest fix needed.
5. Whether the epic can move to `done`, and the exact `status.md` update.

For billing, imports, documents, or workflow epics, explicitly inspect idempotency/concurrency or provider/transition safeguards. Do not change files in this audit.

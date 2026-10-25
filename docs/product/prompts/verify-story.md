# Prompt: Verify one TaxDesk user story

Use after implementation. This is an audit only; do not implement fixes unless explicitly requested.

---

Audit the current codebase against **TaxDesk {story ID}: {story title}** in **Epic {N}**.

**Read:**

- @docs/product/prd/epic-{NN}-{slug}.md
- @{relevant `docs/technical/*.md` documents}
- @docs/product/definition-of-done.md
- @AGENTS.md, if it exists

**Output exactly:**

1. A table mapping every story acceptance criterion to `met`, `partial`, or `missing`, with evidence file paths and test names.
2. A table of applicable Definition of Done checks with status and evidence.
3. A security/integrity check covering organization scope, permissions, sensitive logging, concurrency, idempotency, and audit history where applicable.
4. Ordered gaps: critical, high, normal, and polish.
5. A recommended PRD checkbox and `status.md` update.

Do not change files or claim completion without evidence from the current codebase.

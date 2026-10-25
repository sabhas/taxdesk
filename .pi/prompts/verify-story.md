---
description: Audit one TaxDesk story against its acceptance criteria and Definition of Done
argument-hint: "<story-id> <epic-prefix> <epic-slug>"
---
Audit only. Do not change files or implement fixes unless explicitly asked afterwards.

Audit the current codebase against **TaxDesk $1** in **Epic ${2:-<NN>}**.

**Read:**

- `docs/product/prd/epic-${2:-NN}-${3:-slug}.md` (the epic prefix is zero-padded, for example `00`)
- Relevant `docs/technical/*.md` documents for this story
- `docs/product/definition-of-done.md`
- `AGENTS.md`, if it exists

**Output exactly:**

1. A table mapping every acceptance criterion for story **$1** to `met`, `partial`, or `missing`, with evidence file paths and test names.
2. A table of applicable Definition of Done checks with status and evidence.
3. A security/integrity check covering authorization, permissions, sensitive logging, concurrency, idempotency, and audit history where applicable.
4. Ordered gaps: critical, high, normal, and polish.
5. A recommended PRD checkbox and `status.md` update.

Do not change files or claim completion without evidence from the current codebase.

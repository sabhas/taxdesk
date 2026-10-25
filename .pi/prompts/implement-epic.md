---
description: Implement a full TaxDesk epic (all unchecked stories)
argument-hint: "<epic-prefix> <epic-slug> [epic-title]"
---
Implement **TaxDesk Epic $1: ${3:-<epic-title>}**.

Use this only when the entire epic is intentionally approved for one delivery effort. Otherwise prefer `/implement-story`.

Follow `docs/product/implementation-workflow.md`.

**Read in order:**

- `docs/product/prd/epic-${1:-NN}-${2:-slug}.md` (the epic prefix is zero-padded, for example `00`)
- `docs/product/implementation-backlog.md`
- `docs/product/status.md`
- `docs/technical/architecture.md`
- `docs/technical/data-model.md`
- `docs/product/definition-of-done.md`
- `AGENTS.md`, if it exists

**Scope**

- In scope: every unchecked story in Epic $1.
- Out of scope: other epics, production migration, and additional providers unless explicitly listed by the epic.

**Execution rules**

- Implement in story order and preserve the stated dependencies.
- Make each story independently testable before continuing.
- Do not replace a provider-neutral interface with direct OneDrive calls.
- Do not weaken authentication, authorization, immutable financial history, or audit requirements to reduce scope.
- If an external dependency fails its documented proof, stop at the safe boundary, report evidence, and do not invent a workaround that changes the approved architecture.

**Deliver**

- All epic acceptance criteria implemented and checked off only after verification.
- Forward-only migrations, shared contracts, APIs, accessible UI, and relevant automated tests.
- Updated technical docs, status, and ADRs when required.
- A release note summarizing user-visible capability, data changes, and operational actions.

Before marking the epic done, run `/verify-epic $1 $2`.

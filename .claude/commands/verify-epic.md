---
description: Audit a completed TaxDesk epic for release readiness
argument-hint: '<epic-prefix> <epic-slug> [epic-title]'
---

Read `.pi/prompts/verify-epic.md` and follow it exactly. It is the single source for this
command; do not rely on any remembered copy of it.

Arguments: `$ARGUMENTS`

The Pi prompt uses shell-style placeholders. Resolve them from the arguments above
(split on whitespace; quoted strings count as one argument):

- A dollar sign followed by a number N: the Nth argument.
- A placeholder written `${N:-default}`: the Nth argument, or `default` when it is missing.
- A placeholder written `${@:N}`: every argument from the Nth onward.

If a required argument (shown in angle brackets in the Pi prompt's `argument-hint`) is
missing, ask for it before starting. References in the Pi prompt to other `/verify-*`
or `/implement-*` commands mean the Claude Code commands of the same name in
`.claude/commands/`.

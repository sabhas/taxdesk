---
title: TaxDesk product documentation
status: accepted
version: 1.0
last_reviewed: 2026-10-25
---

# Product documentation

| Document | Purpose |
| --- | --- |
| [Roadmap](roadmap.md) | Release phases and 14-sprint schedule |
| [Implementation backlog](implementation-backlog.md) | Exact build order, points, dependencies, and unlocks |
| [Implementation workflow](implementation-workflow.md) | Mandatory read order, scope rules, and build order |
| [Definition of Done](definition-of-done.md) | Minimum quality bar for every story |
| [Implementation status](status.md) | Current epic and sprint progress |
| [Epic PRDs](prd/README.md) | User stories and acceptance criteria |

The product owner accepts stories during the Sprint Review against their explicit acceptance criteria. A story may move to the next sprint only if it meets the Definition of Done.

## Agent prompts

Implementation and verification prompts are Pi slash commands in [`.pi/prompts`](../../.pi/prompts), not product documentation:

| Command | Purpose |
| --- | --- |
| `/implement-sprint` | Run a committed sprint backlog |
| `/implement-epic` | Implement a full approved epic |
| `/implement-story` | Implement one user story as a vertical slice |
| `/verify-story` | Audit one story against its acceptance criteria |
| `/verify-epic` | Audit a completed epic for release readiness |

Each command accepts positional arguments; type the command name and read its argument hint.
Epic prefixes are zero-padded, so `/implement-story TD-001 00 foundation-and-platform` resolves
`prd/epic-00-foundation-and-platform.md`. See the
[Pi prompt-template reference](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/prompt-templates.md)
for argument syntax.

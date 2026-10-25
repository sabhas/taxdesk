# Prompt: Run a TaxDesk sprint backlog

Copy this into a planning/implementation chat after the Product Owner has committed the sprint scope.

---

Execute **TaxDesk Sprint {N}: {goal}** from @docs/product/roadmap.md.

**Committed stories:** {list exact TD IDs only}

Follow @docs/product/implementation-workflow.md.

**Read:**

- @docs/product/roadmap.md
- @docs/product/implementation-backlog.md
- @docs/product/status.md
- @{each epic PRD containing a committed story}
- @docs/product/definition-of-done.md
- @docs/technical/architecture.md
- @docs/technical/data-model.md
- @AGENTS.md, if it exists

**Rules**

- Implement stories in dependency order, one vertical slice at a time.
- Do not start an uncommitted story even if it appears small.
- Run the story verification prompt before moving to the next material story.
- If a blocker threatens the Sprint Goal, report its evidence and propose only options consistent with the approved architecture.
- At sprint end, update PRD checkboxes, status, tests, migrations, runbooks, and the next-sprint risk list.

**Sprint Review output**

1. Sprint Goal: achieved / not achieved, with evidence.
2. Completed stories and acceptance-criteria evidence.
3. Carried-over stories and reason.
4. Production/staging migration or operational changes.
5. Known risks and recommended next sprint scope.

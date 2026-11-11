# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) holds the binding architecture, data, security, and
documentation rules. Its opening line about the repo being "planning state" is out of
date: Epic 0 is implemented and Epic 1 (identity, MFA, authorization) is implemented
locally. Check `docs/product/status.md` for the current state before starting work.

The `/implement-story`, `/implement-epic`, `/implement-sprint`, `/verify-story`, and
`/verify-epic` commands listed in `AGENTS.md` work in Claude Code too. The files in
`.claude/commands/` are thin wrappers that load the matching `.pi/prompts/*.md` file,
which stays the single source. Edit the Pi prompt, not the wrapper. Only add a wrapper
when you add a new Pi prompt.

## Commands

All commands run from the repo root; `README.md` and `package.json` scripts list them.
`pnpm verify` is the full CI gate.

Run a single test file or test name within one package:

```bash
pnpm --filter @taxdesk/api test -- src/routes/auth.test.ts
pnpm --filter @taxdesk/api test -- src/routes/auth.test.ts -t "<test name>"
```

PostgreSQL integration suites are skipped unless a disposable database whose name ends
in `_test` is configured:

- `pnpm test:migrations` needs `TAXDESK_MIGRATIONS_TEST_DATABASE_URL`
- `pnpm test:api-db` needs `TAXDESK_API_TEST_DATABASE_URL` (or the migrations URL)

Migrations read `DATABASE_URL` from the root `.env`/`.env.local`. After adding a new
SQL file to `packages/database/migrations/`, run `db:migrate:manifest` to record its
checksum. Never modify an existing migration: the manifest check fails CI. Ask before
running migrations or recovery CLIs (`auth:bootstrap`, `auth:recover`) against any
non-test database.

## Conventions and gotchas

- Add a contract to `packages/shared` first (Zod schemas, DTOs, the `ROLE_DEFINITIONS`
  role/permission catalog), then consume it in the API and the web app.
- Product code never imports `onedrive-spike`, a throwaway TD-005 harness.
- Changing a file in `.github/workflows/` can fail `ci:workflows`. See
  `docs/technical/ci.md`.
- Identity decisions are recorded in `docs/adr/0001` and `0002`. Users sign in with a
  permanent username, not an email. MFA is mandatory TOTP. There is no public
  registration: invitation links are shown in the app, never emailed.

## TypeScript conventions

Strict mode is on with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`verbatimModuleSyntax`. Relative imports use `.js` extensions (ESM), and type-only
imports use `import type`.

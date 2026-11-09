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

Node 22+, pnpm 10+. All commands run from the repo root (see `README.md` for the full
list, including deploy and CI-gate commands).

```bash
pnpm install --frozen-lockfile
pnpm typecheck      # tsc --noEmit in every package
pnpm lint           # eslint, including import-boundary rules
pnpm format         # prettier --write (format:check in CI)
pnpm test           # vitest run in every package
pnpm verify         # full gate: typecheck, lint, format, test, migration checksums,
                    # secret scan, workflow policy, config posture, gate self-test, build
pnpm dev:api        # wrangler dev on :8787
pnpm dev:web        # vite; proxies /health and /api to :8787
```

Run a single test file or test name within one package:

```bash
pnpm --filter @taxdesk/api test -- src/routes/auth.test.ts
pnpm --filter @taxdesk/api test -- src/routes/auth.test.ts -t "<test name>"
```

Package names: `@taxdesk/api`, `@taxdesk/web`, `@taxdesk/shared`, `@taxdesk/database`,
`@taxdesk/platform`, `@taxdesk/test-utils`, `@taxdesk/onedrive-spike`.

PostgreSQL integration suites are skipped unless a disposable database whose name ends
in `_test` is configured:

- `pnpm test:migrations` needs `TAXDESK_MIGRATIONS_TEST_DATABASE_URL`
- `pnpm test:api-db` needs `TAXDESK_API_TEST_DATABASE_URL` (or the migrations URL)

Migrations: `pnpm db:migrate`, `pnpm db:migrate:status`, `pnpm db:migrate:verify`, and
`pnpm db:migrate:manifest`. These read `DATABASE_URL` from the root `.env`/`.env.local`.
After adding a new SQL file to `packages/database/migrations/`, run
`db:migrate:manifest` to record its checksum. Never modify an existing migration: the
manifest check fails CI. Ask before running migrations or recovery CLIs
(`auth:bootstrap`, `auth:recover`) against any non-test database.

## Architecture

The pnpm workspace is a modular monolith deployed on Cloudflare: Pages hosts the web
app and a Worker hosts the API, backed by PostgreSQL via Hyperdrive.

**Package boundaries** are enforced by `eslint-plugin-boundaries` in
`eslint.config.js`. `shared` imports nothing. `database` imports only `shared`. `api`
imports `shared`, `database`, and `test-utils`. `web` imports `shared` and `test-utils`.
`platform` and `onedrive-spike` import only `shared`. Product code never imports
`onedrive-spike`, which is a throwaway TD-005 harness.

**Request path:** the browser makes same-origin calls only. In dev, Vite proxies to
wrangler. In Pages, `packages/web/functions/[[path]].ts` forwards `/health` and `/api`
to the Worker through the `API` service binding.

**API (`packages/api/src`)** follows a layered layout:

- `app.ts`: builds the Hono app. It applies request-ID, security-header, and
  origin-check middleware, enforces request IDs on mutations, and maps errors (including
  `AuthError`) to Problem Details via `problem-details.ts`.
- `dependencies.ts`: `composeDependencies()` is the composition root. It wires crypto
  (`crypto/`), domain services (`domain/auth/*-service.ts`), and a repository bundle.
  Production builds request-scoped PostgreSQL repositories. Tests pass
  `repositories/in-memory.ts` through `testing/harness.ts`.
- `repositories/ports.ts`: the repository and `UnitOfWork` interfaces, implemented by
  both `postgres.ts` and `in-memory.ts`. A new repository needs both implementations.
- `routes/`: transport only. These files parse input with shared Zod schemas, call a
  domain service, and map the response.
- `middleware/auth.ts`: every `/api/v1` route must declare exactly one access policy
  with `protect()` (`public`, `session`, `self_service`, `permission`, or
  `self_or_permission`). `routes/route-policy.test.ts` fails if a route lacks one.
  `routes/authorization.test.ts` drives every built-in role against every permission.
- `cli/`: the offline `bootstrap` and `recover` CLIs, bundled with esbuild.

**Shared (`packages/shared/src`)** holds the Zod schemas and DTOs used on both sides
(identity, auth, firm, audit, Problem Details, request ID). It also holds the
role/permission catalog `ROLE_DEFINITIONS`. Add a contract here first, then consume it
in the API and the web app.

**Database (`packages/database`)** contains the Drizzle schema (`src/schema.ts`), the
SQL executor, the forward-only migration runner, and `migrations/*.sql` plus
`manifest.json`.

**Web (`packages/web/src`)** is a React 18 app without a router library. It has
`pages/`, `components/`, `session/`, and thin clients (`api-client.ts`,
`auth-client.ts`) that call the API. Tests use Testing Library and include an axe
accessibility check.

**Platform (`packages/platform`)** is a single CLI behind the `ci:*` scripts. It
covers secret scanning, workflow policy for `.github/workflows/`, config posture, a
gate self-test, staging smoke checks, DB posture, and backup evidence. Changing a
workflow file can fail `ci:workflows`. See `docs/technical/ci.md`.

Identity decisions are recorded in `docs/adr/0001` and `0002`. Users sign in with a
permanent username, not an email. MFA is mandatory TOTP. There is no public
registration: invitation links are shown in the app, never emailed.

## TypeScript conventions

Strict mode is on with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`verbatimModuleSyntax`. Relative imports use `.js` extensions (ESM), and type-only
imports use `import type`.

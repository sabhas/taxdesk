---
title: "Epic 0: Foundation and Platform Validation"
status: in_progress
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-04
related:
  - ../roadmap.md
  - ../../technical/architecture.md
  - ../definition-of-done.md
---

# Epic 0: Foundation and Platform Validation

## Scope

Deliver a deployable, observable skeleton and prove that the intended OneDrive Personal account can support the document workflow. This epic creates no real business functionality.

**Out of scope:** client data, authentication UI, production secrets, real customer documents, and a OneDrive adapter used by the product.

## Sprint 1 backlog — 20 points

### TD-001 — Workspace and quality baseline — 3 points

**User story:** As an engineer, I want a consistent workspace and quality commands so that every contributor builds and validates the same application.

- [x] Create pnpm workspace packages for the React web app, API, shared contracts, database, and test utilities.
- [x] Enable strict TypeScript, linting, formatting, and import-boundary checks.
- [x] Provide one documented command for install, type check, lint, test, and build.

### TD-002 — Isolated environments — 3 points

**User story:** As an operator, I want separate local, staging, and production environments so that experiments cannot affect firm data.

- [x] Configure separate managed PostgreSQL databases, Hyperdrive bindings, and secret sets for development, staging, and production.
- [x] Deploy the React application to Cloudflare Pages and the Hono API to Cloudflare Workers; connect to managed PostgreSQL through Hyperdrive over TLS.
- [x] Provide a `/health` response with environment, release version, and request ID only.
- [x] Confirm health responses never reveal secrets, database names, connection details, or infrastructure addresses.

### TD-003 — Migration discipline — 5 points

**User story:** As an engineer, I want repeatable migrations so that database changes are safe and traceable.

- [x] Create a forward-only migration runner and initial migration ledger.
- [x] Support clean managed development-database setup and staging migration application.
- [x] Reject edited historical migrations in CI through checksums.
- [x] Document rollback as a compensating forward migration or controlled database restore.

### TD-004 — API and web walking skeleton — 3 points

**User story:** As an engineer, I want the browser and API deployed together so that later features inherit a working delivery path.

- [x] Serve the React shell from Cloudflare Pages and route same-origin API requests to the staged Hono Worker.
- [x] Define shared Problem Details error schema and request-ID middleware.
- [x] Show a friendly web error state when the API health call fails.

### TD-005 — OneDrive Personal feasibility spike — 4 points

**Verified 2026-10-31.** All six scenarios passed against a real Microsoft
Personal account on the second run; evidence is committed at
[`docs/product/evidence/td-005-onedrive-spike-report.json`](../../evidence/td-005-onedrive-spike-report.json)
and the recorded scopes, callback, expiry behaviour, file-size behaviour, upload
resumption, and reconnect procedure are in
[`docs/product/sprint-1-review-notes.md`](../sprint-1-review-notes.md).

**User story:** As a firm administrator, I want proof that the intended Microsoft account can safely support the planned storage workflow before the application depends on it.

- [x] Register a non-production Microsoft application and delegated OAuth callback.
- [x] Request only documented minimum Graph permissions for OneDrive upload/download.
- [x] Test consent, token refresh, upload, download, upload interruption, and revoked consent using non-confidential test files.
- [x] Record scopes, callback URLs, observed expiry behavior, file-size behavior, and reconnect procedure in the sprint review notes.
- [x] Raise a blocking decision if any required scenario fails.

### TD-006 — Continuous integration and staging deployment — 2 points

**Implemented 2026-11-04.** Pipeline, gates, and runbook are in
[`docs/technical/ci.md`](../../technical/ci.md); the protected workflow files are
`.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`, and
`.github/workflows/platform-posture.yml`. The first CI-driven staging run and the
staging-provider posture evidence are recorded in Sprint Review.

**User story:** As a product owner, I want every change validated before it reaches staging so that defects are found early.

- [x] Run install, type check, lint, tests, migration validation, build, and secret scanning in CI. (`Quality gates`, `Clean database migrations`, and `Secret history scan` jobs; `pnpm ci:secrets`, `pnpm ci:workflows`, `pnpm ci:selftest`.)
- [x] Deploy passing main-branch changes to the isolated staging environment. (`.github/workflows/deploy-staging.yml` runs only after a successful `main` push CI run, or a manual full-SHA dispatch, in the `staging` environment.)
- [ ] Confirm Hyperdrive uses TLS and a least-privilege credential, point-in-time recovery is enabled, independent exports leave the provider, and failed backup checks alert an operator. **Gate implemented and tested** in `pnpm ci:db-posture`, `pnpm ci:backup-check`, and `.github/workflows/platform-posture.yml`; the staging `PLATFORM_POSTURE_EVIDENCE_JSON` record and first successful scheduled run are still required from the operator before this is checked.
- [x] Ensure pull-request builds cannot read production secrets. (`ci.yml` uses read-only permissions and no `secrets.*` or environment; `pnpm ci:workflows` rejects `pull_request` workflows that enter an environment or read secrets.)

## Exit criteria

- Staging loads a web shell that successfully receives an API health response.
- A clean managed development database can migrate to the latest version.
- CI blocks a deliberately failing check.
- The OneDrive spike has a documented pass/fail outcome.

---
title: "Epic 0: Foundation and Platform Validation"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
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

- [ ] Create pnpm workspace packages for the React web app, API, shared contracts, database, and test utilities.
- [ ] Enable strict TypeScript, linting, formatting, and import-boundary checks.
- [ ] Provide one documented command for install, type check, lint, test, and build.

### TD-002 — Isolated environments — 3 points

**User story:** As an operator, I want separate local, staging, and production environments so that experiments cannot affect firm data.

- [ ] Configure local PostgreSQL for development and separate managed PostgreSQL databases, Hyperdrive bindings, and secret sets for staging and production.
- [ ] Deploy the React application to Cloudflare Pages and the Hono API to Cloudflare Workers; connect to managed PostgreSQL through Hyperdrive over TLS.
- [ ] Provide a `/health` response with environment, release version, and request ID only.
- [ ] Confirm health responses never reveal secrets, database names, connection details, or infrastructure addresses.

### TD-003 — Migration discipline — 5 points

**User story:** As an engineer, I want repeatable migrations so that database changes are safe and traceable.

- [ ] Create a forward-only migration runner and initial migration ledger.
- [ ] Support clean local database setup and staging migration application.
- [ ] Reject edited historical migrations in CI through checksums.
- [ ] Document rollback as a compensating forward migration or controlled database restore.

### TD-004 — API and web walking skeleton — 3 points

**User story:** As an engineer, I want the browser and API deployed together so that later features inherit a working delivery path.

- [ ] Serve the React shell from Cloudflare Pages and route same-origin API requests to the staged Hono Worker.
- [ ] Define shared Problem Details error schema and request-ID middleware.
- [ ] Show a friendly web error state when the API health call fails.

### TD-005 — OneDrive Personal feasibility spike — 4 points

**User story:** As a firm administrator, I want proof that the intended Microsoft account can safely support the planned storage workflow before the application depends on it.

- [ ] Register a non-production Microsoft application and delegated OAuth callback.
- [ ] Request only documented minimum Graph permissions for OneDrive upload/download.
- [ ] Test consent, token refresh, upload, download, upload interruption, and revoked consent using non-confidential test files.
- [ ] Record scopes, callback URLs, observed expiry behavior, file-size behavior, and reconnect procedure in the sprint review notes.
- [ ] Raise a blocking decision if any required scenario fails.

### TD-006 — Continuous integration and staging deployment — 2 points

**User story:** As a product owner, I want every change validated before it reaches staging so that defects are found early.

- [ ] Run install, type check, lint, tests, migration validation, build, and secret scanning in CI.
- [ ] Deploy passing main-branch changes to the isolated staging environment.
- [ ] Confirm Hyperdrive uses TLS and a least-privilege credential, point-in-time recovery is enabled, independent exports leave the provider, and failed backup checks alert an operator.
- [ ] Ensure pull-request builds cannot read production secrets.

## Exit criteria

- Staging loads a web shell that successfully receives an API health response.
- A clean local database can migrate to the latest version.
- CI blocks a deliberately failing check.
- The OneDrive spike has a documented pass/fail outcome.

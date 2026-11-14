---
title: "Security review: release candidate (TD-709)"
status: draft
version: 1.0
owners: [engineering, product]
last_reviewed: 2026-11-14
related:
  - prd/epic-07-migration-security-and-recovery.md
  - production-readiness-review.md
  - ../technical/architecture.md
  - ../technical/ci.md
---

# Security review: release candidate (TD-709)

Scope: the code on `main` after Epics 0–7 (API Worker, web app, shared
contracts, migrations `0001`–`0010`, CI workflows, and operations tooling),
reviewed against OWASP ASVS 4.0 Level 2 principles. This is an internal
review, not a third-party penetration test (out of scope for Epic 7).

Status is `draft` until the platform owner reviews the open findings below and
the Product Owner accepts it in Sprint Review.

## Scans

| Scan | Command | Result (2026-11-14) |
| --- | --- | --- |
| Committed secrets | `pnpm ci:secrets` (CI gate on every PR) | 460 tracked files, 0 findings |
| Dependency advisories, before remediation | `pnpm audit` | 3 critical, 3 high, 19 moderate, 3 low |
| Dependency advisories, after remediation | `pnpm audit` | 0 critical, 0 high, 3 moderate, 1 low (all development tooling) |
| CI and deployment workflow policy | `pnpm ci:workflows` | 4 workflows, 0 violations |
| Gate self-test | `pnpm ci:selftest` | every gate rejects its failing input |

## Review by area

| Area (ASVS) | Control in TaxDesk | Evidence | Result |
| --- | --- | --- | --- |
| Authorization matrix (V4) | Every `/api/v1` route declares one `protect()` policy; roles and permissions come from the session, never the request; record rules (assignment, client visibility) live in domain services. `imports.manage` is administrator-only. | `route-policy.test.ts` (no unprotected route), `authorization.test.ts` (every role × permission), per-feature route tests incl. `imports.test.ts` | Pass |
| Authentication (V2) | Username + PBKDF2-SHA-256 (versioned), mandatory TOTP MFA, recovery codes hashed, login throttling by hashed account/network keys, Turnstile after failures, no public registration | ADR 0001/0002, `auth.test.ts`, `policy.test.ts` | Pass |
| Session and tokens (V3) | Opaque random session token, only its SHA-256 stored; `__Host-` cookie, `Secure`, `HttpOnly`, `SameSite=Strict`; idle and absolute expiry; revocation on password/MFA/role change; activation links single-use, 30 minutes | `cookies.ts`, `session-service.ts`, `lifecycle.test.ts` | Pass |
| Field encryption (V6, V8) | CNIC/NTN: AES-256-GCM ciphertext + HMAC blind index with separate keys, masked display only; MFA secrets and storage tokens AES-256-GCM with key versions; import rows store no cell values; backups AES-256-GCM with an offline key | ADR 0004/0006/0009, `identifier-protection.test.ts`, `credential-vault.test.ts`, `postgres-imports.integration.test.ts` (no identifier in import tables), `ops.test.ts` | Pass |
| Logs and errors (V7) | Structured allow-listed operational logs; raw errors, bodies, bindings, and provider responses never logged or returned; Problem Details with request IDs; audit metadata is flat scalars without secrets | `app.ts` error handler, `problem-details.test.ts`, audit masking in the explorer | Pass |
| Input validation (V5) | Zod contracts on every request and response; strict objects; CSV import parser rejects binary/malformed input, bounds size, rows, and cells, and never echoes values | shared contract tests, `imports.test.ts` | Pass |
| Content Security Policy and headers (V14) | Pages: `default-src 'self'`, no inline script, `frame-ancestors 'none'`, Turnstile only as an explicit source; API: `default-src 'none'`, `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, HSTS, COOP/CORP; PDF and CSV downloads `no-store` with `nosniff` (PDF `sandbox`) | `packages/web/public/_headers`, `middleware/security.ts`, ADR 0003 build check | Pass |
| Exports (V8) | Report and import CSV exports need permission, are audited, escape formula-leading cells, and carry masked or code-only values | `csv.test.ts`, `reports.test.ts`, `imports.test.ts` | Pass |
| Provider access (V9, V13) | OneDrive only through `DocumentStorageProvider`; OAuth state single-use and hashed, PKCE; tokens encrypted at rest and row-locked on refresh; the browser never talks to Graph or PostgreSQL | ADR 0006, `boundary.test.ts`, `storage.test.ts` | Pass |
| Transport and database (V9) | TLS required to PostgreSQL outside development; least-privilege, non-owner application role verified by `ci:db-posture` | `database-posture.test.ts`, staging posture run | Pass |
| CSRF and request integrity (V13) | `SameSite=Strict` session, Origin/`Sec-Fetch-Site` check on mutations, mandatory request IDs, `If-Match` on editable records, `Idempotency-Key` on financial and import commits | `request-id.test.ts`, billing and import route tests | Pass |
| Supply chain and CI (V14) | PR builds read no secrets and enter no environment; actions pinned; staging deploy only from a green `main` push; secret scanning gate | `workflow-policy.test.ts`, `ci.md` | Pass |

## Findings

### Resolved in this review

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| SR-01 | Critical | Vitest UI server arbitrary file read (GHSA-5xrq-8626-4rwp). Development only. | Upgraded `vitest` to 4.1.12 in every package. |
| SR-02 | Critical | Tinypool prototype-pollution gadgets to RCE (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr). Development only. | Removed with Vitest 4 (no longer depends on tinypool). |
| SR-03 | High | Drizzle ORM SQL injection through improperly escaped identifiers (GHSA-gpj5-g38j-94v9). Runtime dependency of `@taxdesk/database`; product queries are parameterized SQL, but the package is loaded. | Upgraded `drizzle-orm` to 0.45.4 and `drizzle-kit` to 0.31.11. |
| SR-04 | High | Zod memory exhaustion validating oversized constrained collections (GHSA-mrhx-c7xc-m3w5). Runtime: every API request is parsed with Zod. | Migrated all packages to `zod` 4.6.7 (record key schemas, error options, `z.iso.datetime()`, `z.url()`, `z.uuid()`, `z.email()`, `.loose()`); all suites pass. |
| SR-05 | High | Vite `launch-editor` existence-check bypass on Windows (GHSA-587h-7wmj-h5pm), plus five moderate/low Vite advisories. Development server only. | Upgraded `vite` to 6.4.6 and `@vitejs/plugin-react` to 5.2.0; production build re-checked. |
| SR-06 | Moderate | Hono `mount()` middleware bypass, RegExpRouter wildcard-middleware skip, `csrf()` gap, form validator gap, `css` helper escaping (5 advisories). Runtime. TaxDesk does not use `mount()`, `csrf()`, `css`, or `validator('form')`, but uses wildcard middleware. | Upgraded `hono` to 4.13.18. |
| SR-07 | Moderate | Direct `esbuild` ≤ 0.24.2 dev-server request forgery (GHSA-67mh-4wv8-2f99). | Upgraded direct `esbuild` to 0.25.12. |

### Open (owner and due date)

| ID | Severity | Finding | Owner | Due |
| --- | --- | --- | --- | --- |
| SR-08 | Moderate | `esbuild` 0.18 remains through `drizzle-kit` → `@esbuild-kit/*` (dev-server issue; drizzle-kit never starts a server here). | Engineering lead | 2026-12-15: replace or drop `drizzle-kit` (migrations are plain SQL) |
| SR-09 | Moderate | `micromatch` ReDoS and `minimatch` glob amplification through `eslint-plugin-boundaries` (lint-time only, trusted input). | Engineering lead | 2026-12-15: upgrade or replace the plugin |
| SR-10 | Medium | No application-wide request-body size limit for JSON routes; the Cloudflare request limit applies and every such route needs a session. The import routes reject a declared body over ~4 MiB and the contract caps files at 2 MiB. | Engineering lead | Before production launch (Epic 8): add a `bodyLimit` middleware per route group |
| SR-11 | Medium | A 5,000-row import commit runs in one Worker request; very large files may hit the Worker CPU limit. Commits are chunked and resume safely with the same key, so the risk is availability, not integrity. | Engineering lead | Migration rehearsal (TD-706): measure the largest file; lower `maxRows` if needed |
| SR-12 | Low | `deepmerge` prototype poisoning through the `shadcn` CLI (developer tool, not shipped). | Engineering lead | 2027-01-31: upgrade with the next shadcn release |
| SR-13 | Low | Duplicate-decision reasons are free text kept in audit history and import exports; an administrator could type personal data into them. | Product Owner | 2027-01-31: add guidance text in the decision dialog |

No critical or high finding remains open.

## Sign-off

| Role | Name | Decision | Date |
| --- | --- | --- | --- |
| Platform owner | | ☐ Accept open findings with the owners and dates above | |
| Product Owner | | ☐ Accept | |

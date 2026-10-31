---
title: Sprint 1 review notes
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-04
related:
  - prd/epic-00-foundation-and-platform.md
  - status.md
  - ../guides/onedrive-spike.md
  - evidence/README.md
---

# Sprint 1 review notes

Sprint 1 covers TD-001 to TD-006. This file is the sprint review record required
by TD-005 and is the single place where the OneDrive Personal spike outcome,
observed provider behaviour, and any blocking decision are written down.

## Sprint 1 status at the time of writing

| Story | Status | Note |
| --- | --- | --- |
| TD-001 Workspace and quality baseline | complete | `pnpm verify` is the single quality gate. |
| TD-002 Isolated environments | complete | Environment matrix and health contract in `docs/technical/environments.md`. |
| TD-003 Migration discipline | complete | Forward-only runner, ledger, checksums in `docs/technical/migrations.md`. |
| TD-004 API and web walking skeleton | complete | Staging Pages → Worker proxy, Problem Details, request IDs. |
| TD-005 OneDrive Personal feasibility spike | **complete — passed** | Run 2 passed all six scenarios against a real Personal account; evidence committed at `docs/product/evidence/td-005-onedrive-spike-report.json`; blocking decision cleared. |
| TD-006 Continuous integration and staging deployment | implementation complete — first CI run pending | CI, staging deploy, workflow policy, secret scanning, database/recovery posture checks, and operator alerting are committed. The staging posture evidence record and first CI-driven staging deploy are captured in Sprint Review. |

The sprint review itself has not been held. The section below is the completed
TD-005 record for the review.

---

## TD-005 — OneDrive Personal feasibility spike

**Outcome:** `passed` — blocking decision cleared.
**Evidence:** [`docs/product/evidence/td-005-onedrive-spike-report.json`](evidence/td-005-onedrive-spike-report.json)
(validated against `OnedriveSpikeReportSchema`, secret-free).
**Run 2:** 2026-10-31T19:44:43Z, operator `Sabir`, application
`a71adcc8-d925-475a-ad09-b42ea1c10b6e`, Personal account, `consumers` authority.
**Run 1:** 2026-10-31T19:21:21Z — `failed`; its findings are retained below.
**Runbook:** [`docs/guides/onedrive-spike.md`](../guides/onedrive-spike.md).

### Conclusion

A Microsoft **Personal** account can support the TaxDesk document workflow with
a delegated `Files.ReadWrite.AppFolder` + `offline_access` grant, using an
app-scoped folder, a 4 MiB single-request threshold, 320 KiB-multiple upload
chunks, resumable upload sessions, and reconnect-required detection. All six
required scenarios passed on the second run.

| Scenario | Run 1 | Run 2 |
| --- | --- | --- |
| `consent` | failed (403 `accessDenied`) | passed |
| `token_refresh` | passed | passed |
| `upload` | failed (404 `itemNotFound`) | passed |
| `download` | skipped | passed |
| `upload_interruption` | passed | passed |
| `revoked_consent` | passed | passed |

Run 1's two failures were **not** provider limitations: one was a defect in the
spike harness and one was lazy app-folder provisioning. Both were corrected and
covered by tests before run 2. See *Findings from run 1*.

### Run 2 scenario detail

| Scenario | Observation |
| --- | --- |
| `consent` | Two scopes requested, one echoed back plus a refresh token; app folder resolved with 1 pre-existing child; access token 3 599 s. |
| `token_refresh` | New access token 3 599 s; refresh token rotated. |
| `upload` | 1 MiB in a single request in 2 093 ms; 5 MiB in 4 × 1.25 MiB chunks in 8 530 ms; no provisioning retries needed. |
| `download` | 2 files, 6 291 456 bytes, every SHA-256 matched. |
| `upload_interruption` | Resumed from byte 1 310 720, 3 further chunks, 5 242 880 bytes, checksum verified. |
| `revoked_consent` | Refresh rejected `invalid_grant` (HTTP 400), classified reconnect-required; fresh authorization-code consent restored access. |

### Findings from run 1 (retained — they shaped the harness)

1. **The app-folder scope does not grant the drive resource.** `GET /me/drive`
   answers `403 accessDenied`. Only `/me/drive/special/approot` and its children
   are reachable. The consent scenario now probes the app folder and records
   `appRoot.resolved` / `appRoot.childCount`; it also provisions the folder before
   any write.
2. **OneDrive provisions the app folder lazily.** The first write returned
   `404 itemNotFound` on a path that worked minutes later. The harness retries the
   first write of each upload path once after 1 500 ms and records
   `upload.simpleUploadRetries`, `upload.sessionRetries`, and
   `interruption.sessionRetries`. Run 2 needed zero retries.
3. **Microsoft does not echo `offline_access`** in the granted scope list while
   still issuing a refresh token, so offline access is proven by the refresh
   token's presence (`consent.refreshTokenIssued`), not by string matching.
4. **The default `--report` path was resolved against the package directory**, so
   run 1's report was written to `packages/onedrive-spike/docs/...`. The default is
   now anchored at the repository root and the absolute path is printed.

### Registered application

| Item | Value |
| --- | --- |
| Application name | `TaxDesk OneDrive Spike (non-production)` |
| Application (client) ID | `a71adcc8-d925-475a-ad09-b42ea1c10b6e` |
| Supported account type | Personal Microsoft accounts only (`consumers` authority) |
| Client secret | None. Public client using authorization code + PKCE (S256). |
| Environment | Non-production only |

Delete this registration once the sprint review accepts the story; it exists only
to produce this evidence.

### Delegated OAuth callback

| Item | Value |
| --- | --- |
| Redirect URI | `http://localhost:8788/oauth/callback` |
| Platform | Mobile and desktop applications (loopback) |
| Flow | Authorization code with PKCE, `response_mode=query`, `prompt=consent` |
| Callback host override | `--host` / `--port`; the registered URI must match exactly |
| State handling | Random per-run state, verified by the loopback listener |

The loopback listener is implemented in
`packages/onedrive-spike/src/node/loopback-oauth.ts` and covered by
`loopback-oauth.test.ts` (matching state, mismatched state, provider error,
missing code, unknown path, timeout).

### Scopes

| Scope | Type | Justification |
| --- | --- | --- |
| `Files.ReadWrite.AppFolder` | Delegated Microsoft Graph permission | Narrowest documented permission that still allows creating, uploading, downloading, and deleting files in the application's own OneDrive folder. |
| `offline_access` | OAuth scope | Required to receive a refresh token, which is the only way to observe refresh and revoked-consent behaviour. |

Not requested: `Files.ReadWrite`, `Files.ReadWrite.All`, `Files.Read.All`,
`Sites.*`, `User.Read`, `openid`, `profile`, `email`, and any app-only
permission.

The consent screen listed only *"Access files in your app folder"* and
*"Maintain access to data you have given it access to"*. `grantedScopes` in the
evidence file shows `Files.ReadWrite.AppFolder` only, because Microsoft does not
echo `offline_access`; the issued refresh token is the proof (finding 3).

Enforced by tests: `packages/shared/src/onedrive-spike.test.ts` ("requests only
the app-folder scope and offline access", "never requests tenant-wide or
whole-drive delegated permissions") and
`packages/onedrive-spike/src/graph/oauth.test.ts` ("requests exactly the
documented minimum scopes with PKCE", "never asks for whole-drive or tenant-wide
permissions").

### Observed expiry behaviour

| Observation | Value (run 2) |
| --- | --- |
| Initial access-token lifetime (`expires_in`) | 3 599 s (≈ 60 min) — same in run 1 |
| Refreshed access-token lifetime | 3 599 s |
| Refresh token rotated on refresh | Yes, in both runs |
| Refresh-token validity window | Not observable from the token response. Plan for Microsoft's published 90-day sliding window for Personal accounts and treat a `invalid_grant` as reconnect-required rather than guessing. |

**Consequence for the adapter:** cache the access token and refresh at roughly
50 minutes, or react to a `401` by refreshing once. A rotated refresh token must
replace the stored one immediately, in the same transaction that used it.

### Observed file-size behaviour

| Observation | Value |
| --- | --- |
| Single-request upload size | 1 MiB (1 048 576 bytes) — 2 093 ms |
| Documented single-request ceiling | 4 MiB (4 194 304 bytes) |
| Upload-session size | 5 MiB (5 242 880 bytes) — 8 530 ms |
| Chunk size | 1.25 MiB (4 × 320 KiB = 1 310 720 bytes) |
| Chunks required | 4 |
| Largest file the firm needs | _pending product input_ |

**Consequence for the adapter:** use a single `PUT …/content` up to 4 MiB and an
upload session above it, with chunks that are a multiple of 320 KiB, and never
assume a chunk succeeds — always resume from the provider-reported
`nextExpectedRanges`.

### Reconnect procedure

1. Treat `invalid_grant`, `interaction_required`, `consent_required`,
   `login_required`, and `invalid_client` as reconnect-required, not transient.
2. Mark the storage connection as needing operator attention; never retry
   silently forever.
3. Re-run delegated consent for the same application and account with only the
   documented scopes.
4. Replace the stored refresh token atomically. Never log, return, or display a
   token value.

**Verified twice:** after removing the app at
<https://account.live.com/consent/Manage>, a refresh was rejected with
`invalid_grant` (HTTP 400), classified as reconnect-required in both runs, and a
fresh authorization-code consent restored access.

### Blocking decision

**Cleared.** Run 2 recorded `passed` for all six required scenarios, so
`evaluateSpikeResults` produced `blockingDecision: { "raised": false }`. Epic 4
document storage may now depend on OneDrive Personal, subject to the rest of its
own acceptance criteria.

### Follow-ups carried into Epic 4

- Confirm the largest file size the firm actually handles before choosing the
  single-request threshold; 4 MiB is Graph's documented practical ceiling, not a
  firm requirement.
- Handle the lazy app-folder `404 itemNotFound` on the very first write, even
  though it did not recur in run 2.
- Do not treat `offline_access` being absent from `grantedScopes` as a missing
  permission.
- The app folder contained 1 pre-existing item at run 2 consent time, i.e. a
  residual from run 1 (the harness only cleans up files created by the current
  run). Empty the folder by hand after the final run and delete the app
  registration.

---

## TD-006 — Continuous integration and staging deployment

**Outcome:** implementation complete; first CI-driven staging deploy and the
staging provider posture record are pending Sprint Review.
**Runbook:** [`docs/technical/ci.md`](../technical/ci.md).

### Delivered

| Concern | Evidence |
| --- | --- |
| Install, type check, lint, format, tests, build | `Quality gates` job in `.github/workflows/ci.yml`; `pnpm verify` runs the same gates locally |
| Migration validation | `pnpm db:migrate:verify` in `Quality gates`; a disposable PostgreSQL service applies a clean database, checks `status --check`, and runs `pnpm test:migrations` in `Clean database migrations` |
| Secret scanning | Full-history `gitleaks` job plus `pnpm ci:secrets` (tracked files, forbidden credential files, redacted findings) |
| Workflow security policy | `pnpm ci:workflows` rejects `pull_request_target`, PR environments/secrets, floating actions, unguarded `workflow_run`, unvalidated manual refs, and non-alert `issues: write` |
| Staging config | `pnpm ci:config-posture` confirms a concrete staging Hyperdrive ID with no local connection string, the Pages preview binding, and the TLS-required database client |
| Staging deployment | `.github/workflows/deploy-staging.yml` deploys only a successful `main` push or a manual full-SHA dispatch, in the protected `staging` environment |
| TLS and least privilege | `pnpm ci:db-posture` reads `pg_stat_ssl` and role attributes; reports contain no role name, host, database name, or connection string |
| PITR, independent exports, alerting | Strict `PlatformPostureEvidenceSchema` in `packages/platform/src/contracts.ts`; `pnpm ci:backup-check` fails closed on missing, stale, or contradictory evidence |
| Operator alerting | Daily `Platform posture` workflow opens or comments on a GitHub issue on failure, with only the run URL |
| PR production-secret isolation | `ci.yml` has `permissions: contents: read`, no `environment`, and no `secrets.*`; policy tests enforce it |
| Failing-gate proof | `pnpm ci:selftest` runs on every build and proves a synthetic secret, unsafe workflow, and failing posture record are rejected |

### Files

- Workflows: `.github/workflows/ci.yml`, `.github/workflows/deploy-staging.yml`,
  `.github/workflows/platform-posture.yml`
- Tooling: `packages/platform/src/{contracts,posture,config-posture,database-posture,secret-scan,workflow-policy,staging-smoke,selftest,cli}.ts`
- Tests: `packages/platform/src/*.test.ts` plus workflow-policy tests that read
  the committed workflows
- Runbook: [`docs/technical/ci.md`](../technical/ci.md)

### Sprint Review actions

1. Create the `staging` GitHub environment and set `STAGING_DATABASE_URL`,
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `PLATFORM_POSTURE_EVIDENCE_JSON`, and the `STAGING_WEB_URL` variable.
2. Record the posture evidence after verifying PITR, a completed independent
   export, and a delivered simulated failure alert. Do not check the remaining
   TD-006 criterion until the scheduled workflow reports success.
3. Enable branch protection requiring `Quality gates`, `Clean database
   migrations`, and `Secret history scan`.
4. Merge to `main` and confirm the first automated staging deploy and smoke
   check. Record the run URL here.
5. Open a deliberately failing pull request and record that the required check
   blocks merge.

### Residual risk

Provider-side recovery facts (PITR window, independent export, alert delivery)
cannot be derived from the repository. They are operator-recorded evidence and
are re-validated daily. The deploy gate fails closed until that record exists and
is fresh.

### Local verification (2026-11-04)

| Command | Result |
| --- | --- |
| `pnpm verify` | Passed: strict types, lint, Prettier, every package's tests, migration checksum verification, secret scan (tracked files, zero findings), workflow policy (3 workflows, zero violations), staging config posture, gate self-test, and build |
| `pnpm test` | 285 tests passed; 5 PostgreSQL migration integration tests skipped because no test database URL was set |
| `pnpm test:migrations` against a disposable PostgreSQL 16 container | 65 tests passed, including clean-database apply, idempotent re-run, checksum drift, and rollback |
| `pnpm db:migrate` + `pnpm db:migrate:status --check` against the same clean database | Applied `0001_initial_baseline.sql`; status reported 1 applied, 0 pending |
| `pnpm ci:db-posture` against the disposable database | Failed closed for a superuser/owner role on plaintext; a `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` non-owner role passed both role checks while plaintext still failed TLS |
| `gitleaks` on the staged tree and Git history | No leaks |
| `gitleaks`/`pnpm ci:secrets` | No findings in tracked files |

**Not yet run:** GitHub Actions, the first CI-driven staging deploy, and the
staging provider posture evidence. Those require the `staging` GitHub
environment credentials and a real provider backup/export verification.

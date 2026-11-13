---
title: Implementation status
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
---

# Implementation status

**Current focus:** Sprint 1 implementation is complete. TD-001 to TD-005 are done, and TD-006 now provides the CI gates, staging delivery workflow, pull-request secret isolation, database/recovery posture checks, and operator alerting. Staging is deployed, migrated, green on `ci:db-posture` after its admin role was replaced with a least-privilege non-owner role, and serves a 15/15 staging smoke check; that check caught and the fix closed an environment-reporting defect in `/api/v1/app-info`. The staging posture evidence record, the first CI-driven staging deploy, and the branch-protection demonstration remain to be captured in Sprint Review.

**Epic 1:** identity, MFA, and authorization (TD-101–TD-111) are implemented and pass every local gate. They await staging configuration, a staging demonstration, and Sprint Review before the epic is marked done.

**Epic 2:** client management (TD-201–TD-206) is implemented and passes every local gate, including the PostgreSQL migration and repository suites. It awaits the two client identifier secrets and migration `0005` in staging, a staging demonstration, and Sprint Review before the epic is marked done.

**Epic 3:** tax-case workflow (TD-301–TD-310) is implemented and passes every local gate, including the PostgreSQL migration and repository suites (database triggers and true concurrent races). It awaits migration `0006` in staging, a staging demonstration, and Sprint Review before the epic is marked done. No new secrets are required.

**Epic 4:** document storage (TD-401–TD-410) is implemented and passes every local gate, including the PostgreSQL migration and repository suites and a `/verify-epic` re-audit. It awaits a staging Microsoft app registration, `STORAGE_TOKEN_ENCRYPTION_KEY`, `ONEDRIVE_CLIENT_ID`, migration `0007`, a staging demonstration against a real OneDrive account, and Sprint Review before the epic is marked done.

**UI foundation (cross-cutting, not a backlog story):** the web app now uses shadcn/ui on Base UI with Tailwind CSS and the "ledger" design tokens ([ADR 0003](../adr/0003-ui-foundation.md), [design system](../technical/design-system.md)). The app shell and all existing Epic 1 screens were migrated with unchanged behavior; the production build was checked against the real content security policy with no violations. It is tracked as TD-007 in the Epic 0 PRD and still needs a staging visual check and Sprint Review acceptance.

**Epic 5:** billing and payments (TD-501–TD-510) is implemented and passes every local gate except `ci:secrets`, which flags two synthetic test values in the Epic 4 file `credential-vault.test.ts` (unchanged by Epic 5). PostgreSQL suites cover concurrent finalization, duplicate payments, over-payment and over-reversal races, and the database guards. It awaits migration `0008` in staging, a staging demonstration, and Sprint Review before the epic is marked done. No new secrets are required.

Update this file when an epic or sprint starts, becomes blocked, or completes.

| Epic | Name | Status | Sprint(s) | Blocked by | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Foundation and platform validation | in_progress | 1 | — | TD-001–TD-006 implemented (OneDrive proof of concept passed; CI and staging delivery gates committed). Staging deployed, migrated, green on `ci:db-posture` (least-privilege non-owner role) and green on a 15/15 staging smoke check; that check caught the `/api/v1/app-info` environment defect, fixed in `7ba50d7`. The posture evidence secret is operator-attested and awaits confirmation by the first CI-driven deploy; the failing-check demonstration is still pending Sprint Review |
| 1 | Identity, MFA, and authorization | in_progress | 2–3 | — | TD-101–TD-111 implemented and verified locally (unit, route, role-matrix, web, and PostgreSQL integration suites; migrations `0002`–`0004`; ADRs 0001–0002; username sign-in; QR MFA setup; recovery runbook). Staging needs `MFA_ENCRYPTION_KEY`, Turnstile keys, and the new migrations, then a staging demonstration and Sprint Review acceptance |
| 2 | Client management | in_progress | 4 | — | TD-201–TD-206 implemented and verified locally (shared contracts, migration `0005`, API with role/assignment rules, duplicate blocking and audited overrides, `If-Match` edits with a refresh-and-review UI, search/filter/cursor paging, archive/restore, masked activity; unit, route, role-matrix, web/axe, and PostgreSQL suites; ADR 0004). Staging needs `CLIENT_DATA_ENCRYPTION_KEY`, `CLIENT_IDENTIFIER_INDEX_KEY`, and migration `0005`, then a staging demonstration and Sprint Review acceptance |
| 3 | Tax-case workflow | in_progress | 5–6 | — | TD-301–TD-310 implemented and verified locally (shared contracts and workflow validator, migration `0006` with triggers for immutable published versions, case snapshots, append-only status history and transition-only status changes, `services.manage` permission and `any_permission` route policy, service/template/case APIs with `If-Match`, row-locked transitions and checklist gates, preparer/reviewer separation, duplicate-case policy, work queues whose counts share the list query, archive; unit, route, role-matrix, web/axe, jsdom lifecycle, and PostgreSQL suites; ADR 0005). Staging needs migration `0006`, then a staging demonstration and Sprint Review acceptance |
| 4 | Document storage | in_progress | 7–8 | — | TD-401–TD-410 implemented and verified locally (`DocumentStorageProvider` port with fake and OneDrive adapters and an import-boundary test, migration `0007` with a singleton encrypted connection, single-use hashed OAuth state with PKCE, immutable/undeletable documents, idempotent uploads, append-only reconciliation runs, `storage.manage` permission, Worker-proxied 5 MiB resumable uploads and audited downloads, row-locked token refresh, reconnect-required stop, verification states and checklist gate, soft delete/restore, reconciliation; unit, route, role-matrix, web/axe, and PostgreSQL suites; ADR 0006). Staging needs a Microsoft app registration, `STORAGE_TOKEN_ENCRYPTION_KEY`, `ONEDRIVE_CLIENT_ID`, and migration `0007`, then a staging demonstration and Sprint Review acceptance |
| 5 | Billing and payments | in_progress | 9–10 | — | TD-501–TD-510 implemented and verified locally (shared money contracts and pure totals calculator, migration `0008` with locked gapless invoice/receipt counters, generic idempotency keys, append-only payment/reversal/billing-PDF tables and immutability triggers on finalized invoices, `billing.payments.reverse` permission, draft/finalize/payment/reversal/void APIs with `If-Match` and `Idempotency-Key`, decoupled `pdf-lib` invoice and receipt PDFs stored through the storage gateway with retry, invoice list/detail/editor UI with record-payment, reverse, and void dialogs; unit, route, role-matrix, web/axe, jsdom journey, and PostgreSQL race/trigger suites; ADR 0007). Staging needs migration `0008`, then a staging demonstration and Sprint Review acceptance |
| 6 | Dashboard and operations | not_started | 11 | Epics 2–5 | Aggregates existing domain data |
| 7 | Migration, security, and recovery | not_started | 12–13 | Epics 2–6 | Requires usable staging workflow |
| 8 | Pilot and production launch | not_started | 14 | Epic 7 | Requires signed migration rehearsal |

**Status values:** `not_started` | `in_progress` | `blocked` | `done`

---
title: Implementation status
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-09
---

# Implementation status

**Current focus:** Sprint 1 implementation is complete. TD-001 to TD-005 are done, and TD-006 now provides the CI gates, staging delivery workflow, pull-request secret isolation, database/recovery posture checks, and operator alerting. Staging is deployed, migrated, green on `ci:db-posture` after its admin role was replaced with a least-privilege non-owner role, and serves a 15/15 staging smoke check; that check caught and the fix closed an environment-reporting defect in `/api/v1/app-info`. The staging posture evidence record, the first CI-driven staging deploy, and the branch-protection demonstration remain to be captured in Sprint Review.

**Epic 1:** identity, MFA, and authorization (TD-101–TD-111) are implemented and pass every local gate. They await staging configuration, a staging demonstration, and Sprint Review before the epic is marked done.

Update this file when an epic or sprint starts, becomes blocked, or completes.

| Epic | Name | Status | Sprint(s) | Blocked by | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Foundation and platform validation | in_progress | 1 | — | TD-001–TD-006 implemented (OneDrive proof of concept passed; CI and staging delivery gates committed). Staging deployed, migrated, green on `ci:db-posture` (least-privilege non-owner role) and green on a 15/15 staging smoke check; that check caught the `/api/v1/app-info` environment defect, fixed in `7ba50d7`. The posture evidence secret is operator-attested and awaits confirmation by the first CI-driven deploy; the failing-check demonstration is still pending Sprint Review |
| 1 | Identity, MFA, and authorization | in_progress | 2–3 | — | TD-101–TD-111 implemented and verified locally (unit, route, role-matrix, web, and PostgreSQL integration suites; migrations `0002`–`0004`; ADRs 0001–0002; username sign-in; QR MFA setup; recovery runbook). Staging needs `MFA_ENCRYPTION_KEY`, Turnstile keys, and the new migrations, then a staging demonstration and Sprint Review acceptance |
| 2 | Client management | not_started | 4 | Epic 1 | Requires authorization and audit service |
| 3 | Tax-case workflow | not_started | 5–6 | Epic 2 | Requires clients and role permissions |
| 4 | Document storage | not_started | 7–8 | Epic 3 | OneDrive Personal proof of concept passed (TD-005); requires Epic 3 cases |
| 5 | Billing and payments | not_started | 9–10 | Epic 1, Epic 3 | Requires audit and idempotency service |
| 6 | Dashboard and operations | not_started | 11 | Epics 2–5 | Aggregates existing domain data |
| 7 | Migration, security, and recovery | not_started | 12–13 | Epics 2–6 | Requires usable staging workflow |
| 8 | Pilot and production launch | not_started | 14 | Epic 7 | Requires signed migration rehearsal |

**Status values:** `not_started` | `in_progress` | `blocked` | `done`

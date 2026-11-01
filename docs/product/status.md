---
title: Implementation status
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-04
---

# Implementation status

**Current focus:** Sprint 1 implementation is complete. TD-001 to TD-005 are done, and TD-006 now provides the CI gates, staging delivery workflow, pull-request secret isolation, database/recovery posture checks, and operator alerting. Staging is deployed, migrated, and now passes the database posture gate after its admin role was replaced with a least-privilege non-owner role; the staging smoke check then caught an environment-reporting defect in `/api/v1/app-info`, fixed in `7ba50d7` and awaiting deploy. The staging posture evidence record, the first CI-driven staging deploy, and the branch-protection demonstration remain to be captured in Sprint Review.

Update this file when an epic or sprint starts, becomes blocked, or completes.

| Epic | Name | Status | Sprint(s) | Blocked by | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Foundation and platform validation | in_progress | 1 | — | TD-001–TD-006 implemented (OneDrive proof of concept passed; CI and staging delivery gates committed). Staging deployed, migrated, and green on `ci:db-posture` after the app role was replaced with a least-privilege non-owner role. The staging smoke check caught an environment-reporting defect in `/api/v1/app-info` (fixed in `7ba50d7`, awaiting deploy). TD-006 staging posture evidence, the first CI-driven staging deploy, and the failing-check demonstration still pending Sprint Review |
| 1 | Identity, MFA, and authorization | not_started | 2–3 | Epic 0 | Requires approved environment and auth decisions |
| 2 | Client management | not_started | 4 | Epic 1 | Requires authorization and audit service |
| 3 | Tax-case workflow | not_started | 5–6 | Epic 2 | Requires clients and role permissions |
| 4 | Document storage | not_started | 7–8 | Epic 3 | OneDrive Personal proof of concept passed (TD-005); requires Epic 3 cases |
| 5 | Billing and payments | not_started | 9–10 | Epic 1, Epic 3 | Requires audit and idempotency service |
| 6 | Dashboard and operations | not_started | 11 | Epics 2–5 | Aggregates existing domain data |
| 7 | Migration, security, and recovery | not_started | 12–13 | Epics 2–6 | Requires usable staging workflow |
| 8 | Pilot and production launch | not_started | 14 | Epic 7 | Requires signed migration rehearsal |

**Status values:** `not_started` | `in_progress` | `blocked` | `done`

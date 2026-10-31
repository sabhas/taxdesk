---
title: Implementation status
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-31
---

# Implementation status

**Current focus:** Sprint 1 in progress. TD-001 to TD-005 are complete: the OneDrive Personal feasibility spike passed all six scenarios against a real Personal account on its second run, and the evidence is committed. TD-006 remains.

Update this file when an epic or sprint starts, becomes blocked, or completes.

| Epic | Name | Status | Sprint(s) | Blocked by | Notes |
| --- | --- | --- | --- | --- | --- |
| 0 | Foundation and platform validation | in_progress | 1 | — | TD-001–TD-005 complete (OneDrive Personal proof of concept passed); TD-006 not started |
| 1 | Identity, MFA, and authorization | not_started | 2–3 | Epic 0 | Requires approved environment and auth decisions |
| 2 | Client management | not_started | 4 | Epic 1 | Requires authorization and audit service |
| 3 | Tax-case workflow | not_started | 5–6 | Epic 2 | Requires clients and role permissions |
| 4 | Document storage | not_started | 7–8 | Epic 3 | OneDrive Personal proof of concept passed (TD-005); requires Epic 3 cases |
| 5 | Billing and payments | not_started | 9–10 | Epic 1, Epic 3 | Requires audit and idempotency service |
| 6 | Dashboard and operations | not_started | 11 | Epics 2–5 | Aggregates existing domain data |
| 7 | Migration, security, and recovery | not_started | 12–13 | Epics 2–6 | Requires usable staging workflow |
| 8 | Pilot and production launch | not_started | 14 | Epic 7 | Requires signed migration rehearsal |

**Status values:** `not_started` | `in_progress` | `blocked` | `done`

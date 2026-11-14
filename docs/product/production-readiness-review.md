---
title: "Production readiness review (TD-710)"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-14
related:
  - status.md
  - definition-of-done.md
  - security-review-2026-11.md
  - ../guides/migration-rehearsal.md
  - ../guides/backup-and-restore.md
  - prd/epic-08-pilot-and-production-launch.md
---

# Production readiness review (TD-710)

Production is not an informal technical switch. Real client records enter
production only after every row below is **Yes** with evidence and the
Product Owner records a **Go** decision with a named rollback owner.

Status on 2026-11-14: **not ready for a decision.** Every epic is implemented
and passes all local gates, but staging demonstrations, the migration
rehearsal sign-off, the restore rehearsal, and Sprint Review acceptance are
still outstanding. The decision below is intentionally blank.

## 1. Prior epics: acceptance criteria and Definition of Done

| Epic | Implemented and locally verified | Staging demonstration | Sprint Review accepted | Ready |
| --- | --- | --- | --- | --- |
| 0 Foundation and platform | Yes | Partly (deployed, posture, smoke; failing-gate demo pending) | No | No |
| 1 Identity, MFA, authorization | Yes | No (needs `MFA_ENCRYPTION_KEY`, Turnstile keys) | No | No |
| 2 Client management | Yes | No (needs client identifier keys, `0005`) | No | No |
| 3 Tax-case workflow | Yes | No (`0006`) | No | No |
| 4 Document storage | Yes | No (Microsoft app registration, storage keys, `0007`, real OneDrive) | No | No |
| 5 Billing and payments | Yes | No (`0008`) | No | No |
| 6 Dashboard and operations | Yes | No (`0009`, browser accessibility pass) | No | No |
| 7 Migration, security, recovery | Yes (TD-701–TD-705 code, TD-706–TD-710 tooling and runbooks) | No (`0010`, backup secrets, rehearsals) | No | No |

Source: [`status.md`](status.md) and each epic's PRD checkboxes.

## 2. Operational evidence

| Item | Required evidence | State |
| --- | --- | --- |
| Managed backups and PITR | Current `PLATFORM_POSTURE_EVIDENCE_JSON`, `ci:backup-check` green | Operator-attested for staging; confirm on the first CI-driven run |
| Independent encrypted export | `backup-export.yml` green for 3 consecutive days; `ci:backup-verify` green in `platform-posture.yml` | Not yet run: needs `BACKUP_ENCRYPTION_KEY`, `STAGING_BACKUP_DATABASE_URL`, `BACKUP_R2_API_TOKEN`, `vars.BACKUP_BUCKET`, R2 bucket and lifecycle rule |
| Restore rehearsal | Completed [evidence form](../guides/backup-and-restore.md#evidence-form) and `restore-evidence.json` within the four-hour RTO, in an isolated environment | Tooling proven in a local dry run only |
| Monitoring and alerting | Posture and export jobs open issues on failure; a deliberate failure was seen to alert | Workflows committed; alert test pending |
| OneDrive health | Storage connection `healthy` on staging; reconciliation run with no missing documents | Pending Epic 4 staging setup |
| Migration sign-off | Signed [rehearsal checklist](../guides/migration-rehearsal.md) | Pending |
| Security review | [Security review](security-review-2026-11.md) signed; no open critical or high finding | No critical/high open; sign-off pending |

## 3. Go / no-go decision

| Field | Value |
| --- | --- |
| Decision (Go / No-go) | |
| Date | |
| Decided by (Product Owner) | |
| Release (commit SHA) | |
| Rollback owner | |
| Rollback trigger | e.g. data integrity check fails, sign-in unavailable for 30 minutes, or reconciliation mismatch after the production import |
| Rollback plan | Stop writes; restore per the [backup and restore runbook](../guides/backup-and-restore.md); redeploy the previous release; notify staff |
| Conditions or exceptions accepted | |

Record the decision in [`status.md`](status.md). Epic 8 (pilot and production
launch) starts only after a Go.

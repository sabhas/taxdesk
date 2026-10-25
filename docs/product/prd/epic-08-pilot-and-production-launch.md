---
title: "Epic 8: Pilot and Production Launch"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - ../roadmap.md
  - ../definition-of-done.md
  - ../status.md
---

# Epic 8: Pilot and Production Launch

## Scope

Run a controlled pilot, validate performance and failure behavior, migrate production records, train users, and operate a one-week monitored launch.

**Out of scope:** feature expansion during pilot, a second firm, automated notifications, and new integrations.

## Sprint 14 backlog — 19 points

### TD-801 — Representative pilot workflows — 4 points

**User story:** As a firm user, I want to complete real representative workflows in staging so that gaps are found before live data is affected.

- [ ] Run intake-to-completion-and-payment scenarios with administrator, consultant, manager, and billing roles.
- [ ] Capture usability defects and classify them by release severity.
- [ ] Resolve release-blocking defects before migration.

### TD-802 — Performance validation — 4 points

**User story:** As the firm, I want evidence that expected larger-firm usage remains responsive.

- [ ] Test synthetic data at 100,000 clients, representative case/document metadata, 250 users, and 50 active concurrent sessions.
- [ ] Verify p95 reads under 500 ms and writes under 800 ms, excluding Microsoft file-transfer time.
- [ ] Investigate and remediate errors above 1%.

### TD-803 — Failure drills — 4 points

**User story:** As an operator, I want known failures rehearsed so that users receive safe, actionable outcomes.

- [ ] Exercise revoked OneDrive access, expired session, stale case edit, duplicate payment retry, interrupted upload, D1 error, and missed backup alert.
- [ ] Verify user-facing error state, audit/log evidence, and operator runbook for each scenario.

### TD-804 — Production migration and acceptance — 4 points

**User story:** As the Product Owner, I want production migration reconciled before staff work in the new system.

- [ ] Freeze source data during the approved migration window.
- [ ] Run final dry run, commit, reconcile counts/balances, and obtain sign-off.
- [ ] Define and test a rollback decision point before enabling general access.

### TD-805 — Training, support, and monitored launch — 3 points

**User story:** As the firm, I want staff and administrators able to operate TaxDesk without engineering intervention.

- [ ] Deliver role-specific quick guides and administrator runbooks.
- [ ] Verify an administrator can create/deactivate a user, reconnect OneDrive, and perform a restoration exercise from documentation.
- [ ] Monitor launch for one business week and triage issues daily.

## Exit criteria

- No unresolved severity-1 or severity-2 issue remains.
- The Product Owner has accepted migration reconciliation and pilot workflows.
- Backups, OneDrive health, audit logging, and operational monitoring are healthy for the launch week.

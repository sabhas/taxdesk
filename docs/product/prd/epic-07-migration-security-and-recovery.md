---
title: "Epic 7: Migration, Security, and Recovery"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - ../roadmap.md
  - ../../technical/data-model.md
  - ../definition-of-done.md
---

# Epic 7: Migration, Security, and Recovery

## Scope

Deliver validated CSV import, reconciliation, backup monitoring, independent recovery proof, and security review before real records enter production.

**Out of scope:** migration of complete historical payment journals, automated extraction from legacy spreadsheets, production use before a signed rehearsal, and third-party penetration testing.

## Sprint 12 backlog — 19 points

### TD-701 — Versioned CSV templates — 3 points

**User story:** As the firm, I want documented templates so that existing clients and active work can enter the system consistently.

- [ ] Publish versioned templates for clients, active cases, and opening invoices/balances.
- [ ] Document required fields, valid formats, normalization, relationships, and examples.
- [ ] Include no real confidential data in templates or fixtures.

### TD-702 — Import batch and dry run — 5 points

**User story:** As an administrator, I want to validate an import without changing data so that errors can be fixed safely.

- [ ] Store upload metadata and a unique source checksum.
- [ ] Parse, normalize, validate references, detect duplicates, and produce row-level errors.
- [ ] Show proposed create/update/skip counts before commit.
- [ ] Prevent commit when blocking errors remain.

### TD-703 — Idempotent import commit — 5 points

**User story:** As an administrator, I want a retry-safe import commit so that a network failure cannot duplicate records.

- [ ] Commit validated rows in bounded transactions with source-row lineage.
- [ ] Require idempotency key and prevent the same approved batch from creating duplicate data.
- [ ] Emit audit events and a reconciliation summary.

### TD-704 — Import review and correction workflow — 3 points

**User story:** As staff, I want to review imported exceptions so that problematic records do not become hidden technical debt.

- [ ] Export row errors and skipped/overridden-row reasons.
- [ ] Require a manager reason for non-exact duplicate override.
- [ ] Link committed rows to created record IDs for traceability.

### TD-705 — Import security tests — 3 points

**User story:** As the firm, I want imports treated as a protected write path so that unauthorized or malformed files cannot corrupt data.

- [ ] Restrict templates, dry runs, and commits to administrator permission.
- [ ] Test unauthorized access, malformed CSV, duplicate retry, and large-file limits.
- [ ] Sanitize exported errors to avoid leaking confidential data.

## Sprint 13 backlog — 18 points

### TD-706 — Migration rehearsal — 4 points

**User story:** As the Product Owner, I want a full rehearsal before production migration so that totals and relationships are trusted.

- [ ] Import a sanitized production-shaped data set into staging.
- [ ] Reconcile client count, active-case count, opening balances, and sampled records against source data.
- [ ] Obtain signed acceptance of the reconciliation checklist.

### TD-707 — Backup automation and monitoring — 4 points

**User story:** As an operator, I want independent backups and failure visibility so that loss of a primary service is recoverable.

- [ ] Verify managed PostgreSQL automated backups and point-in-time recovery, then create encrypted daily exports outside the database provider.
- [ ] Record backup success/failure, source version, and retention metadata.
- [ ] Alert on missing managed-backup coverage or failed independent exports.

### TD-708 — Restore rehearsal — 4 points

**User story:** As the firm, I want to prove recovery works before relying on it.

- [ ] Restore into an isolated environment using documented runbook steps.
- [ ] Verify authentication configuration, record counts, case status, and financial balances.
- [ ] Measure recovery time against four-hour RTO; retain the test evidence.

### TD-709 — Security review — 3 points

**User story:** As a platform owner, I want a documented security assessment so that launch decisions are evidence-based.

- [ ] Review authorization matrix, session/token handling, field encryption, logs, CSP, exports, and provider access against OWASP ASVS Level 2 principles.
- [ ] Run dependency and secret scans.
- [ ] Resolve critical/high findings; assign owner and due date to lower findings.

### TD-710 — Production readiness review — 3 points

**User story:** As the Product Owner, I want an explicit release decision so that production is not an informal technical switch.

- [ ] Confirm every prior epic’s acceptance criteria and Definition of Done.
- [ ] Confirm backup/restore evidence, monitoring, OneDrive health, and migration sign-off.
- [ ] Record go/no-go decision and rollback owner.

## Exit criteria

- The migration process has been rehearsed, reconciled, and signed off.
- Recovery works in an isolated environment.
- No critical or high security finding remains.

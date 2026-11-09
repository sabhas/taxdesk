---
title: TaxDesk domain model and invariants
status: accepted
version: 1.0
owners: [engineering]
last_reviewed: 2026-11-09
related:
  - architecture.md
  - ../taxdesk-implementation-plan.md
---

# Domain model and invariants

## Core relationships

```text
User ──< Role Assignment
Client ──< Tax Case ──< Case Checklist Item
                         ├──< Document
                         ├──< Case Status History
                         └──< Invoice ──< Invoice Item
                                           └──< Payment ──< Payment Reversal
Storage Connection
Audit Event
```

## Shared record rules

- All business tables contain `id`, `created_at`, `updated_at`, and `version`; archive-capable tables also contain `deleted_at`.
- IDs are UUIDv7. Timestamps are UTC ISO-8601 values.
- Business identifiers such as invoice numbers are unique within the deployment.
- Each deployment contains one firm only; its data is isolated by its dedicated application, database, secrets, and storage connection.

## Operational tables

The migration ledger (`taxdesk_migration_ledger`) is operational metadata rather
than a business table: it records the name, SHA-256 checksum, UTC timestamp,
duration, and applying database role of each forward-only migration. It is
bootstrapped by the migration runner and is never edited by hand. See
[migrations.md](migrations.md) for the schema, checksum rules, and rollback
policy.

## Identity tables

Migration `0002_identity_and_authorization.sql` adds `firm_settings` (a
singleton enforced by a constant unique index), `roles`, `permissions`,
`role_permissions`, `users`, `user_roles`, `sessions`, `activation_tokens`,
`login_challenges`, `mfa_credentials`, `mfa_recovery_codes`, `auth_attempts`,
and `audit_events`. Migration `0003_consultant_assigned_case_work.sql` adds the
`cases.work_assigned` permission. The role/permission matrix lives in
`ROLE_DEFINITIONS` in `@taxdesk/shared`; a seed test fails if the SQL and the
shared catalog drift.

- Users are `invited` (no password hash), `active`, or `deactivated` (with
  `deactivated_at`); database checks enforce both pairings. Deactivation never
  deletes a user, so audit history keeps its actor references.
- Sessions, activation/reset links, MFA login challenges, and recovery codes
  store only SHA-256 digests of their random values. TOTP secrets are
  AES-256-GCM ciphertext with a `key_version`. Password hashes are versioned
  PBKDF2-HMAC-SHA-256 strings.
- `auth_attempts` stores hashed account and network keys only, never an email
  or IP address, and is pruned after 24 hours.
- `audit_events` is append-only: a trigger rejects every `UPDATE` and `DELETE`.
  Metadata is a flat object of scalar values and never holds credentials,
  tokens, or secrets.

## Integrity rules

- Tax identifiers use encrypted ciphertext for display and an HMAC blind index for exact duplicate detection.
- A case retains a snapshot of its selected workflow and checklist template version.
- Status history is append-only.
- Draft invoices may change; final invoices, payments, and reversals cannot be edited or deleted.
- A payment reversal references one original payment and may not exceed that payment's unreversed amount.
- Invoice balance is derived and updated atomically within the transaction that changes financial entries.
- Documents store provider-neutral external identifiers, metadata, verification state, and linkage to client/case/checklist item; file bytes never enter PostgreSQL.
- Audit events exclude raw credentials, refresh tokens, and unmasked national identifiers.

---
title: TaxDesk domain model and invariants
status: accepted
version: 1.0
owners: [engineering]
last_reviewed: 2026-10-25
related:
  - architecture.md
  - ../taxdesk-implementation-plan.md
---

# Domain model and invariants

## Core relationships

```text
Organization ──< Membership >── User
Organization ──< Client ──< Tax Case ──< Case Checklist Item
                                  ├──< Document
                                  ├──< Case Status History
                                  └──< Invoice ──< Invoice Item
                                                    └──< Payment ──< Payment Reversal
Organization ──< Storage Connection
Organization ──< Audit Event
```

## Shared record rules

- All business tables contain `id`, `organization_id`, `created_at`, `updated_at`, and `version`; archive-capable tables also contain `deleted_at`.
- IDs are UUIDv7. Timestamps are UTC ISO-8601 values.
- Tenant uniqueness is composite, for example `(organization_id, invoice_number)`.
- A client, case, document, invoice, payment, or audit event is never visible across organization boundaries.

## Integrity rules

- Tax identifiers use encrypted ciphertext for display and an HMAC blind index for exact duplicate detection.
- A case retains a snapshot of its selected workflow and checklist template version.
- Status history is append-only.
- Draft invoices may change; final invoices, payments, and reversals cannot be edited or deleted.
- A payment reversal references one original payment and may not exceed that payment's unreversed amount.
- Invoice balance is derived and updated atomically within the transaction that changes financial entries.
- Documents store provider-neutral external identifiers, metadata, verification state, and linkage to client/case/checklist item; file bytes never enter D1.
- Audit events exclude raw credentials, refresh tokens, and unmasked national identifiers.

---
title: TaxDesk domain model and invariants
status: accepted
version: 1.0
owners: [engineering]
last_reviewed: 2026-11-11
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
`cases.work_assigned` permission. Migration `0004_username_sign_in.sql` replaces
the email columns with a unique, permanent, lowercase `username`. The role/permission matrix lives in
`ROLE_DEFINITIONS` in `@taxdesk/shared`; a seed test fails if the SQL and the
shared catalog drift.

- Users are `invited` (no password hash), `active`, or `deactivated` (with
  `deactivated_at`); database checks enforce both pairings. Deactivation never
  deletes a user, so audit history keeps its actor references.
- Sessions, activation/reset links, MFA login challenges, and recovery codes
  store only SHA-256 digests of their random values. TOTP secrets are
  AES-256-GCM ciphertext with a `key_version`. Password hashes are versioned
  PBKDF2-HMAC-SHA-256 strings.
- `auth_attempts` stores hashed account and network keys only, never a username
  or IP address, and is pruned after 24 hours.
- `audit_events` is append-only: a trigger rejects every `UPDATE` and `DELETE`.
  Metadata is a flat object of scalar values and never holds credentials,
  tokens, or secrets.

## Client tables

Migration `0005_client_management.sql` adds `clients`, `client_contacts`, the
`client_code_seq` sequence, the `clients.read_all` permission, and an
`audit_events (entity_type, entity_id, id DESC)` index for per-record activity.
See [ADR 0004](../adr/0004-client-identifier-protection-and-visibility.md).

- `client_code` (`CL-00001`) is drawn from `client_code_seq` server-side and is
  never reused, even after a rolled-back create.
- `client_type` is `individual` (CNIC required, NTN optional) or `business`
  (NTN required, never a CNIC). Required fields by type are enforced by the
  shared Zod contract and the API; the database enforces that a business has
  no CNIC. The type cannot change after creation.
- Each identifier is a triple of `*_ciphertext`, `*_blind_index`, and
  `*_masked` that is all-null or all-set (check constraints). Partial unique
  indexes on the blind indexes block exact duplicates deployment-wide,
  including archived clients. Plaintext identifiers are never stored.
- `normalized_name` and `normalized_display_name` hold the lowercase,
  punctuation-free, suffix-stripped name used for search and duplicate
  warnings. Contacts store `email_normalized` (lowercase) and
  `phone_normalized` (digits in international form, `0300…` → `92300…`).
- `deleted_at` is the archive timestamp. Archived clients keep every relation
  and their history and are excluded from default search and selection.
- `client_contacts` rows belong to one client, have a unique `position`, at
  most one `is_primary` row per client, and need an email or a phone. An edit
  replaces the client's contact set inside the client's versioned update.
- Client edits use `version` with `If-Match`; a stale version returns `412`.
- Client audit events (`client.created`, `client.updated`, `client.archived`,
  `client.restored`, `client.duplicate_override`) record changed field names,
  masked identifiers, and override reasons only, never field values, notes,
  or contact details.

## Tax-case workflow tables

Migration `0006_tax_case_workflow.sql` adds `service_types`,
`workflow_templates`, `workflow_template_versions`, `tax_cases`,
`tax_case_code_seq`, `case_status_history`, `case_checklist_items`, and the
`services.manage` permission (administrator, manager). See
[ADR 0005](../adr/0005-case-workflow-integrity-and-authorization.md).

- `service_types` hold a name (unique among active services), a default fee in
  integer minor units (`default_fee_minor`, paisa), a default deadline offset
  in days after the case is opened, a duplicate-case policy (`warn` or
  `block`), and an optional default workflow template. `deleted_at` archives a
  service; archived services keep their cases and cannot be chosen for new ones.
- A `workflow_template_versions.definition` is one JSON document with ordered
  `statuses` (key, name, kind `open`/`filed`/`completed`/`cancelled`, initial
  flag, checklist gate), allowed `transitions`, and ordered `checklist` items
  (key, label, document type, required, review required, instructions). The
  shared `WorkflowDefinitionSchema` validates its shape and
  `validateWorkflowDefinition` its rules (one open initial status, every
  status reachable, Filed/Completed gate on the checklist, terminal statuses
  have no way out, every other status has one). A template has at most one
  `draft`; `published` versions are immutable and never deleted (trigger).
- `tax_cases` copy the service name and fee, the template name and version
  number, and the version's statuses and transitions (`workflow_snapshot`)
  when opened. A trigger rejects changes to those columns, to `client_id`, and
  to `tax_year`. `case_code` (`TC-00001`) comes from `tax_case_code_seq` and is
  never reused. `due_date` is a calendar date; queues compare it with "today"
  in the firm timezone. `primary_consultant_user_id` may be null (unassigned
  queue); the reviewer is optional and never the primary consultant.
- The current status (`current_status_key`, `_name`, `_kind`) changes only by
  pointing `current_status_history_id` at a new `case_status_history` row that
  records exactly that change and is the case's newest row (trigger).
  `case_status_history` is append-only and keeps the note, actor, request ID,
  and time of every move, including the initial status.
- `case_checklist_items` are copied from the version and keep their own
  `version` for `If-Match`. States are `open` → `completed` → (`verified` |
  `rejected`); verification is only for review-required items and
  `reviewed_by` can never equal `completed_by` (check constraint). Items are
  never deleted. The checklist is locked once a case leaves an open status.
- Only `completed` or `cancelled` cases can be archived (`deleted_at`, check
  constraint); archived cases are read-only and cases are never deleted.
- Case audit events (`case.created`, `case.updated`, `case.status_changed`,
  `case.archived`, `case.duplicate_override`, `case.checklist_*`) record
  changed field names, new due dates, assignee IDs, status names, and
  checklist item labels. They never record notes or comments, which stay on
  the case.
- Queue lists and counts share one filter (`matchesCaseFilter` in memory,
  `caseFilterSql` in PostgreSQL); an integration test checks they agree.

## Document storage tables

Migration `0007_document_storage.sql` adds `storage_connections`,
`storage_oauth_states`, `documents`, `document_uploads`,
`storage_reconciliation_runs`, and the administrator-only `storage.manage`
permission. See [ADR 0006](../adr/0006-provider-neutral-document-storage.md).

- `storage_connections` holds at most one row (singleton index): provider type,
  status (`not_connected`, `healthy`, `reconnect_required`, `unavailable`), a
  code-only health reason, external drive and app-root folder IDs, an account
  label, and the AES-256-GCM `token_ciphertext` with its `token_key_version`.
  Check constraints keep the ciphertext and key version together, require a
  token while connected, and forbid one once disconnected. Disconnecting wipes
  the token and keeps the row.
- `storage_oauth_states` stores only the SHA-256 digest of each consent state,
  the encrypted PKCE verifier, the starting administrator, and a ten-minute
  expiry. A state is consumed once.
- `documents` keep the provider-neutral reference (`provider_type`,
  `external_item_id`, plus drive, parent, and ETag for reconciliation), file
  name, allowlisted content type, size, document type, and links to the
  client, optional case, and optional checklist item. Paths are never stored.
  A trigger forbids deletes, changes to the client, storage reference, or
  upload facts, and links to a case of another client or an item of another
  case. `verification_state` is `pending`, `verified`, `rejected`, or
  `missing_provider`; `provider_state` is `present`, `missing`, or `moved`.
  `deleted_at`/`deleted_by` mark a soft delete; default lists exclude them.
  Edits use `version` with `If-Match`.
- `document_uploads` track a resumable upload: the pre-assigned document ID
  (so the storage path is stable), the encrypted provider session handle, the
  next byte offset, and the state (`active`, `completed`, `cancelled`,
  `expired`, `failed`). `(created_by, request_id)` is unique so a retried create
  returns the same upload, and `documents.upload_id` is unique so completing an
  upload twice yields one document.
- `storage_reconciliation_runs` are append-only (trigger) and record counts of
  checked, present, missing, moved, and recovered documents, the connection
  status, and the recommended next action.
- A required checklist item with a document type is satisfied only by a
  linked, non-deleted, `verified` document.
- Storage and document audit events (`storage.*`, `document.*`) record
  document type, content type, size, and client/case codes. They never record
  tokens, upload URLs, provider responses, or document contents.

Migration `0008_billing_and_payments.sql` adds invoices, line items, payments,
reversals, billing PDFs, gapless number counters, and idempotency keys, plus the
`billing.payments.reverse` permission (administrator and manager). See
[ADR 0007](../adr/0007-billing-integrity-and-idempotency.md).

- `number_sequences` holds one counter row per `invoice` and `receipt`. A
  number is drawn by an `UPDATE … RETURNING` in the allocating transaction, so
  the row lock queues callers and a rollback leaves no gap.
- `idempotency_keys` is unique on `(actor_user_id, scope, key)` and stores a
  SHA-256 `request_hash` and the stored `response`. A key reused for another
  request is detected by the hash.
- `invoices` carry `client_id`, an optional `case_id` (a trigger requires the
  case to belong to the client), `currency` (`PKR`), `status`
  (`draft`/`finalized`/`void`), a unique `invoice_number` (null while a draft),
  `issue_date`/`due_date`, and bigint minor-unit `subtotal`, `discount`,
  `total`, `paid`, and `outstanding` columns. Checks enforce
  `total = subtotal − discount`, `discount ≤ subtotal`,
  `outstanding = total − paid`, `0 ≤ paid ≤ total`, a payment status that
  matches the amounts, paired finalize and void columns, a positive total once
  finalized, and `paid = 0` once void. `pdf_state`
  (`none`/`pending`/`ready`/`failed`) and `pdf_document_id` track the PDF.
  A trigger makes a finalized invoice's number, dates, amounts, and notes
  immutable, makes `void` terminal, and forbids every delete.
- `invoice_items` are unique on `(invoice_id, position)` with
  `line_total = quantity × unit_amount`; a trigger rejects any insert, update,
  or delete once the invoice is not a draft.
- `payments` carry a unique `receipt_number`, a positive amount, method
  (`cash`, `bank_transfer`, `cheque`, `card`, `other`), received date,
  reference, recorder, and a receipt PDF state. A trigger allows inserts only
  against a finalized invoice, makes every column immutable except the receipt
  PDF columns, and forbids deletes.
- `payment_reversals` are append-only (trigger) and linked to one payment and
  its invoice; each carries a required reason. The service rejects a reversal
  above the payment's unreversed amount under the invoice row lock.
- `billing_documents` are append-only references to stored invoice and receipt
  PDFs (`provider_type`, `external_item_id`, never a path). They are separate
  from `documents`, so billing PDFs never appear in document lists, checklists,
  or reconciliation.
- Invoice and payment audit events (`billing.*`) record the invoice or receipt
  number, client and case codes, amount, and currency. They never record names,
  identifiers, or document contents.

## Integrity rules

- Tax identifiers use encrypted ciphertext for display and an HMAC blind index for exact duplicate detection.
- A case retains a snapshot of its selected workflow and checklist template version.
- Status history is append-only.
- Draft invoices may change; final invoices, payments, and reversals cannot be edited or deleted.
- A payment reversal references one original payment and may not exceed that payment's unreversed amount.
- Invoice balance is derived and updated atomically within the transaction that changes financial entries.
- Documents store provider-neutral external identifiers, metadata, verification state, and linkage to client/case/checklist item; file bytes never enter PostgreSQL.
- Audit events exclude raw credentials, refresh tokens, and unmasked national identifiers.

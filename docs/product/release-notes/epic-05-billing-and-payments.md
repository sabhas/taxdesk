---
title: "Release note: Epic 5 billing and payments"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-12
related:
  - ../prd/epic-05-billing-and-payments.md
  - ../../adr/0007-billing-integrity-and-idempotency.md
  - ../../technical/data-model.md
---

# Release note: Epic 5 billing and payments (TD-501–TD-510)

Draft until staging demonstration and Sprint Review acceptance.

## What users can do

- **Create invoices** (billing staff and administrators): **Create invoice** on a
  case starts a draft with the service name and fee as its first line; on a
  client it starts empty. Drafts can add, change, reorder, and remove line
  items, set a discount, dates, and notes. The totals shown are a preview: the
  server recomputes them when you save.
- **Finalize**: a finalized invoice gets the next number (`INV-00001`, no gaps)
  and its lines and amounts are frozen. A mistake is corrected by voiding and
  issuing a new invoice.
- **Invoice PDF**: a PDF is stored in the firm's document storage after
  finalizing and can be downloaded from the invoice. If storage is down, the
  invoice is still saved and shows "PDF could not be stored" with a
  **Generate PDF again** button.
- **Record payments**: full or partial, with method, received date, and
  reference. Every payment gets a receipt number (`RCP-00001`) and a receipt
  PDF. Amounts above the balance are refused.
- **Reverse a payment** (administrators and managers): a mistaken payment is
  corrected with a linked reversal entry and a reason; the original payment
  stays in the history.
- **Void**: an invoice (draft or finalized) with no net payments can be voided
  with a reason. It stays visible with its number and history.
- **Find invoices**: **Invoices** lists every invoice with filters for status
  and payment state, total, and outstanding. Case and client pages show their
  own invoices. Billing never changes a case's status.

## Roles

| Role | Read invoices | Draft, finalize, pay, void | Reverse a payment |
| --- | --- | --- | --- |
| Administrator | yes | yes | yes |
| Manager | yes | no | yes |
| Billing | yes | yes | no |
| Read-only | yes | no | no |
| Consultant | no | no | no |

## Data changes

- Migration `0008_billing_and_payments.sql` adds `number_sequences`,
  `idempotency_keys`, `invoices`, `invoice_items`, `payments`,
  `payment_reversals`, `billing_documents`, their immutability triggers, and the
  `billing.payments.reverse` permission. See the data model and ADR 0007.
- Billing PDFs are kept apart from client documents: they never appear in
  document lists or checklists and are only served to roles with billing
  access.

## Operational actions

- Apply migration `0008` in staging. No new secrets or configuration.
- Every financial request carries an `Idempotency-Key`; the web app does this
  automatically. Integrations must send one.
- Billing PDFs are not part of storage reconciliation. A missing file shows a
  clear message on download.
- Not included: online payments, accounting sync, credit notes, recurring
  billing, and overpayment handling.

---
title: "ADR 0007: Billing integrity, idempotency, and decoupled PDFs"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-12
related:
  - ../product/prd/epic-05-billing-and-payments.md
  - ../technical/data-model.md
  - ./0006-provider-neutral-document-storage.md
---

# ADR 0007: Billing integrity, idempotency, and decoupled PDFs

Status is `proposed` until the Product Owner accepts Epic 5 in Sprint Review.

## Context

Epic 5 creates the firm's accountable financial records. Its exit criteria are
that finalized invoices, payments, and reversals are append-only, that a
network retry can never duplicate a financial entry, and that billing status
stays independent of case status. Several choices change the data model,
security posture, or public contracts.

## Decisions

1. **Gapless numbers from locked counters.** `number_sequences` holds one row
   each for invoices (`INV-00001`) and receipts (`RCP-00001`). Allocation is an
   `UPDATE … RETURNING` inside the finalizing or paying transaction, so the row
   lock queues concurrent callers and a rollback returns the number. A
   PostgreSQL `SEQUENCE` was rejected because it skips values on rollback.
2. **Idempotency keys.** Financial commands (finalize, record payment, reverse,
   void) and the PDF retry require an `Idempotency-Key` header
   (16–128 characters). One generic `idempotency_keys` table is unique on
   `(actor, scope, key)` and stores a SHA-256 of the canonical request and the
   response. The claim is made with `INSERT … ON CONFLICT DO NOTHING` as the
   first statement of the transaction that does the work, so a concurrent
   duplicate waits for the first transaction, then reads its stored response.
   A retry returns the original response (status 200); the same key with a
   different request returns 409 `IDEMPOTENCY_KEY_REUSED`. A rolled-back
   transaction rolls the claim back with it. The table is generic so Epic 7
   imports can reuse it.
3. **Append-only by database guards, not only by code.** Triggers make a
   non-draft invoice's number, dates, amounts, and notes immutable (only the
   balance columns, PDF state, and void columns change), freeze line items
   once the invoice leaves `draft`, forbid deleting invoices and payments, make
   payments immutable except their receipt-PDF columns, and make reversals and
   billing documents append-only. `void` is terminal and requires `paid = 0`.
   Check constraints tie `total = subtotal − discount`,
   `outstanding = total − paid`, and the payment status to the amounts.
4. **Derived balance columns.** `paid_minor`, `outstanding_minor`, and
   `payment_status` are updated in the same transaction (under the invoice row
   lock) that appends a payment or reversal. Paid is net of reversals.
   Concurrent payments serialize on the invoice lock, so together they can
   never exceed the outstanding amount.
5. **Reversal permission.** `billing.payments.reverse` (administrator and
   manager) is separate from `billing.manage`, which records payments. A
   manager can reverse but not record; billing staff can record but not
   reverse.
6. **Void rule.** A draft or finalized invoice can be voided with a reason and
   explicit confirmation, only when net paid is zero. The number, finalize
   metadata, and audit history stay visible. Payments on a void invoice are
   refused.
7. **PDFs decoupled from the financial commit.** Finalize and record-payment
   commit without touching storage. A separate idempotent step renders a PDF
   from the committed rows (pure-JavaScript `pdf-lib`, Worker-safe) and stores
   it through `StorageGateway`. The invoice and each payment carry a PDF state
   (`pending`, `ready`, `failed`) and a retry action. A storage outage never
   undoes or blocks an invoice or payment.
8. **Billing PDFs live in `billing_documents`, not `documents`.** An earlier
   draft added a `source` column to `documents`. A separate append-only table
   was chosen instead: billing PDFs then cannot appear in document lists,
   checklist satisfaction, verification, or reconciliation, and the Epic 4
   document guard is untouched. Consultants hold `documents.read` but not
   `billing.read`, so billing PDFs are served only through billing routes,
   which check `billing.read` and audit every download. The table keeps the
   provider-neutral external item ID, never a path. Reconciliation of billing
   PDFs is out of scope for this epic.
9. **Currency.** The deployment currency stays the `FIRM_CURRENCY` constant
   (`PKR`) and is copied onto every invoice, so a later firm-settings currency
   (TD-604) cannot change an issued invoice.

## Consequences

- Retried finalize, payment, reversal, and void requests are safe.
- A voided invoice cannot be reopened; correct a mistake with a new invoice.
- The PDF of a finalized invoice shows totals only, never the paid amount, so
  it stays true as payments change and is never regenerated or edited.
- Operators run migration `0008`; no new secrets are required.
- Billing PDFs are not covered by storage reconciliation; a missing file shows
  as a failed download with a clear message.

---
title: "Epic 5: Billing and Payments"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - ../roadmap.md
  - ../../technical/data-model.md
  - ../definition-of-done.md
---

# Epic 5: Billing and Payments

## Scope

Deliver draft and finalized invoices, case-linked billing, provider-stored invoice PDFs, partial payments, receipts, reversals, void rules, and accurate balances.

**Out of scope:** online payment gateways, accounting-system synchronization, tax filing calculations, credit notes, recurring subscriptions, and overpayment handling.

## Sprint 9 backlog — 20 points

### TD-501 — Invoice schema and money rules — 3 points

**User story:** As the firm, I want consistent invoice data and arithmetic so that balances never depend on browser calculations.

- [ ] Store all amounts as integer minor currency units with the deployment's firm currency.
- [ ] Represent draft/finalized/void status, issue/due dates, optional case, line items, discount, and calculated totals.
- [ ] Validate totals server-side and reject negative subtotal or malformed line items.

### TD-502 — Invoice draft creation and editing — 5 points

**User story:** As billing staff, I want to prepare an invoice from a case or client so that service work can be billed accurately.

- [ ] Create a draft from a case with service default fee, or manually from a client.
- [ ] Add, reorder, change, and remove draft line items with clear totals.
- [ ] Require ETag for edits and permission checks for every mutation.
- [ ] Keep case status independent from invoice status.

### TD-503 — Finalize an invoice — 4 points

**User story:** As billing staff, I want to finalize an approved draft so that its amount and number become an accountable financial record.

- [ ] Allocate a unique deployment-wide invoice number within the finalization transaction.
- [ ] Freeze line items and totals after finalization.
- [ ] Require idempotency key and return the original outcome on retry.
- [ ] Emit invoice-finalized audit event with masked safe summary.

### TD-504 — Generate invoice PDF — 4 points

**User story:** As billing staff, I want a branded invoice PDF so that I can send a consistent document to the client.

- [ ] Generate PDF from finalized invoice data only.
- [ ] Store it through the document storage port and link it to the invoice.
- [ ] Verify PDF total, currency, number, and client match the finalized database record.

### TD-505 — Invoice list and detail — 4 points

**User story:** As a manager, I want to find invoice state and amounts quickly so that I can manage collections.

- [ ] Filter by client, case, status, issue/due date, and balance state.
- [ ] Display total, paid, outstanding, and linked receipts/documents.
- [ ] Provide clear empty, permission-denied, stale, and unavailable-provider states.

## Sprint 10 backlog — 19 points

### TD-506 — Record payments — 5 points

**User story:** As billing staff, I want to record full or partial payments so that outstanding balances are current.

- [ ] Record amount, method, received date, reference, and recorder.
- [ ] Reject zero, negative, duplicate-idempotency, and overpayment amounts.
- [ ] Recalculate invoice paid/outstanding/payment status atomically.
- [ ] Preserve immutable payment history.

### TD-507 — Issue payment receipts — 3 points

**User story:** As billing staff, I want a receipt for every payment so that a client can confirm what was recorded.

- [ ] Allocate a deployment-wide receipt number atomically.
- [ ] Generate a receipt PDF through the storage provider.
- [ ] Link receipt to payment and invoice without editing the invoice PDF.

### TD-508 — Reverse a payment — 4 points

**User story:** As an authorized manager, I want to reverse a mistaken payment through a correction entry so that audit history remains truthful.

- [ ] Require original payment, reversal amount, reason, and idempotency key.
- [ ] Prevent reversal above unreversed value.
- [ ] Record a linked immutable reversal and recalculate balance atomically.
- [ ] Restrict reversal permission separately from payment recording.

### TD-509 — Void unpaid invoice — 3 points

**User story:** As billing staff, I want to void an unpaid invoice rather than delete it so that billing history remains explainable.

- [ ] Permit void only when no active payment exists.
- [ ] Require reason and explicit confirmation.
- [ ] Keep number, draft/final metadata, and audit history visible.

### TD-510 — Financial integrity verification — 4 points

**User story:** As the firm, I want financial operations tested under retries and concurrency so that totals remain reliable.

- [ ] Test concurrent finalization, duplicate payment submission, partial payment, reversal, void, and stale update paths.
- [ ] Add a browser journey from case to invoice to partial payment to full settlement.
- [ ] Verify financial routes require explicit, tested permissions.

## Exit criteria

- Final invoices, payments, and reversals are append-only.
- A network retry cannot duplicate a financial entry.
- Invoice/payment status and case status remain separate.

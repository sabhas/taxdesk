---
title: "ADR 0012: Firm logo on billing PDFs and sharing invoices from the device"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-22
related:
  - ../product/prd/epic-05-billing-and-payments.md
  - ../technical/data-model.md
  - ./0007-billing-integrity-and-idempotency.md
  - ./0008-dashboard-reports-and-firm-settings.md
---

# ADR 0012: Firm logo on billing PDFs and sharing invoices from the device

Status is `proposed` until the Product Owner accepts TD-512 and TD-513 in
Sprint Review.

## Context

After testing staging, the firm's representative asked for two things: the
firm's logo on invoices, set by administrators, and a way to share an invoice
with the client directly from TaxDesk. TaxDesk has no email or messaging
integration, and identity decisions already avoid sending email (ADR 0001,
ADR 0002). The firm's clients are mostly reached on WhatsApp.

## Decision

1. **The logo is firm configuration stored in PostgreSQL.** One PNG or JPEG of
   at most 512 KiB and 2000 pixels a side lives in `firm_logos` beside
   `firm_settings`, not in client document storage. It is small, has no client
   data, and must be available whenever a PDF is generated, even while document
   storage needs reconnecting. A separate table keeps the bytes off the settings
   row that most requests read. Database checks pin the type and require
   `byte_size` and `sha256` to describe the stored bytes.
2. **The server decides what the file is.** The type comes from the file
   signature, the dimensions are checked before anything decodes the image, the
   whole image is decoded (pdf-lib for PNG; `jpeg-js` in strict mode for JPEG,
   because pdf-lib copies JPEG data without decoding it), and the image must
   embed in a PDF with the same library that prints it. The
   declared content type and file name are ignored. SVG and other formats are
   refused, which also removes any script-in-image risk.
3. **Logo changes are versioned settings changes.** Upload, replace, and remove
   need `firm.settings.manage`, `If-Match` on the firm settings version, and a
   request ID. Each bumps that version and appends `firm.logo_updated` or
   `firm.logo_removed` with the type, size, and SHA-256 digest, never the bytes.
4. **Stored PDFs are never regenerated.** A PDF uses the logo current when it is
   generated. Existing invoice and receipt PDFs keep theirs, consistent with the
   immutable financial records in ADR 0007.
5. **Sharing goes through the staff member's device, not TaxDesk.** Share uses
   the browser's file share sheet (Web Share API) with the invoice PDF. Where
   the browser cannot share files, it downloads the PDF and opens WhatsApp with a
   pre-filled message for the client's primary phone. TaxDesk sends nothing
   itself: there is no public invoice link, email provider, or new secret.
6. **A completed share is audited.** The client reports a completed share and
   the server appends `billing.invoice_shared` after rechecking that the actor can see
   the invoice and that it is finalized with a ready PDF. A cancelled share sheet
   records nothing. The message carries no CNIC or NTN.

## Consequences

- Firm settings responses describe the logo (type, size, digest, time) and the
  image is served separately from `GET /api/v1/firm/logo`, with the digest in
  the URL so browsers cache it safely.
- `GET /api/v1/invoices/{id}/share` returns the server-built message, the PDF
  file name, and the WhatsApp phone digits (primary contact first, then the
  first contact with a phone). `POST /api/v1/invoices/{id}/shares` records a
  completed share. Both use the invoice download policy (`billing.read` plus
  invoice visibility); fetching the PDF to attach is the existing audited
  download.
- Every PDF generation reads the logo (at most 512 KiB) from the database.
- The audit trail shows that a share was started and completed on the device.
  It cannot prove that the client received the message, because WhatsApp and
  the share target are outside TaxDesk.
- On desktop browsers without file sharing, staff attach the downloaded PDF to
  the WhatsApp chat themselves.
- Not included: emailing invoices, public or expiring client links, delivery
  tracking, per-invoice logo choice, and logos on non-billing documents.

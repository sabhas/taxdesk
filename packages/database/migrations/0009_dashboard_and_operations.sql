-- TaxDesk migration 0009: dashboard and operations (Epic 6).
--
-- Moves ordinary business choices out of deployment configuration and into the
-- firm's settings row, and adds the indexes the reports and audit explorer
-- filter on:
--   * currency (PKR is the only currency invoices support today),
--   * invoice and receipt number prefixes (apply to numbers issued from now on;
--     issued numbers are never rewritten),
--   * the document upload size limit,
--   * the dashboard "due soon" window.
--
-- Invoice and receipt numbers were pinned to `INV-` and `RCP-` by migration
-- 0008. Those checks are replaced with a general `AAA-00000` pattern; the
-- immutability triggers on finalized invoices and payments are untouched.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

ALTER TABLE firm_settings
  ADD COLUMN currency text NOT NULL DEFAULT 'PKR'
    CONSTRAINT firm_settings_currency_check CHECK (currency IN ('PKR')),
  ADD COLUMN invoice_prefix text NOT NULL DEFAULT 'INV'
    CONSTRAINT firm_settings_invoice_prefix_check CHECK (invoice_prefix ~ '^[A-Z]{2,6}$'),
  ADD COLUMN receipt_prefix text NOT NULL DEFAULT 'RCP'
    CONSTRAINT firm_settings_receipt_prefix_check CHECK (receipt_prefix ~ '^[A-Z]{2,6}$'),
  ADD COLUMN document_max_upload_bytes integer NOT NULL DEFAULT 262144000
    CONSTRAINT firm_settings_document_max_upload_bytes_check
    CHECK (document_max_upload_bytes BETWEEN 1048576 AND 262144000),
  ADD COLUMN due_soon_days integer NOT NULL DEFAULT 7
    CONSTRAINT firm_settings_due_soon_days_check CHECK (due_soon_days BETWEEN 1 AND 60);

ALTER TABLE invoices DROP CONSTRAINT invoices_invoice_number_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_invoice_number_check
  CHECK (invoice_number IS NULL OR invoice_number ~ '^[A-Z]{2,6}-[0-9]{5,}$');

ALTER TABLE payments DROP CONSTRAINT payments_receipt_number_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_receipt_number_check
  CHECK (receipt_number ~ '^[A-Z]{2,6}-[0-9]{5,}$');

-- Audit explorer filters (actor and entity already have indexes).
CREATE INDEX audit_events_action_idx ON audit_events (action, id DESC);
CREATE INDEX audit_events_request_idx ON audit_events (request_id);

-- Billing report filters.
CREATE INDEX invoices_issue_date_idx ON invoices (issue_date) WHERE status = 'finalized';
CREATE INDEX payments_received_on_idx ON payments (received_on);

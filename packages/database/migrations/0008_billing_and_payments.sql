-- TaxDesk migration 0008: billing and payments (Epic 5).
--
-- Adds invoices with line items, payments, payment reversals, stored billing
-- PDFs, gapless invoice/receipt number counters, and a generic idempotency
-- key table. Money is a bigint count of minor units in the deployment's firm
-- currency.
--
-- Invariants enforced here as well as in the API:
--   * a finalized invoice's number, dates, line items, and totals never change;
--     only its paid/outstanding/payment-status, PDF, and void columns do;
--   * void is terminal and allowed only while net paid is zero;
--   * invoices are never deleted (the UI voids instead);
--   * payments are append-only except for their receipt-PDF columns;
--   * payment reversals are append-only and linked to their payment;
--   * invoice and receipt numbers are drawn from counter rows that are
--     row-locked by the allocating transaction, so a rollback leaves no gap;
--   * one idempotency key per actor and scope can create at most one outcome;
--   * stored billing PDFs are immutable and never listed as client documents.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'billing.payments.reverse', 'Reverse a recorded payment with a correction entry.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'billing.payments.reverse'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'billing.payments.reverse'
]::text[])
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Number counters (TD-503, TD-507)
-- ---------------------------------------------------------------------------

CREATE TABLE number_sequences (
  key text PRIMARY KEY CHECK (key IN ('invoice', 'receipt')),
  next_value bigint NOT NULL CHECK (next_value >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO number_sequences (key, next_value) VALUES ('invoice', 1), ('receipt', 1);

-- ---------------------------------------------------------------------------
-- Idempotency keys (TD-503, TD-506, TD-508, TD-509)
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,128}$'),
  -- SHA-256 of the canonical request, so reusing a key for another request is detected.
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  resource_id uuid,
  response jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_unique UNIQUE (actor_user_id, scope, key)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- Invoices (TD-501, TD-502, TD-503, TD-509)
-- ---------------------------------------------------------------------------

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients (id),
  case_id uuid REFERENCES tax_cases (id),
  currency text NOT NULL CHECK (currency = 'PKR' AND currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('draft', 'finalized', 'void')),
  invoice_number text UNIQUE CHECK (invoice_number IS NULL OR invoice_number ~ '^INV-[0-9]{5,}$'),
  issue_date date,
  due_date date,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor BETWEEN 0 AND 1000000000000),
  discount_minor bigint NOT NULL CHECK (discount_minor BETWEEN 0 AND 1000000000000),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 1000000000000),
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor BETWEEN 0 AND 1000000000000),
  outstanding_minor bigint NOT NULL CHECK (outstanding_minor BETWEEN 0 AND 1000000000000),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (
    payment_status IN ('unpaid', 'partially_paid', 'paid')
  ),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  finalized_at timestamptz,
  finalized_by uuid REFERENCES users (id),
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 1 AND 500),
  voided_at timestamptz,
  voided_by uuid REFERENCES users (id),
  pdf_state text NOT NULL DEFAULT 'none' CHECK (pdf_state IN ('none', 'pending', 'ready', 'failed')),
  pdf_document_id uuid,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT invoices_total_arithmetic CHECK (
    total_minor = subtotal_minor - discount_minor AND discount_minor <= subtotal_minor
  ),
  CONSTRAINT invoices_balance_arithmetic CHECK (
    outstanding_minor = total_minor - paid_minor AND paid_minor <= total_minor
  ),
  CONSTRAINT invoices_payment_status_matches CHECK (
    payment_status = CASE
      WHEN paid_minor = 0 THEN 'unpaid'
      WHEN paid_minor >= total_minor THEN 'paid'
      ELSE 'partially_paid'
    END
  ),
  CONSTRAINT invoices_due_after_issue CHECK (
    issue_date IS NULL OR due_date IS NULL OR due_date >= issue_date
  ),
  CONSTRAINT invoices_finalized_parts CHECK (
    (finalized_at IS NULL) = (finalized_by IS NULL)
    AND (finalized_at IS NULL) = (invoice_number IS NULL)
  ),
  CONSTRAINT invoices_status_matches_finalization CHECK (
    status <> 'finalized' OR (finalized_at IS NOT NULL AND issue_date IS NOT NULL AND total_minor > 0)
  ),
  CONSTRAINT invoices_draft_is_unnumbered CHECK (status <> 'draft' OR invoice_number IS NULL),
  CONSTRAINT invoices_draft_has_no_payments CHECK (status <> 'draft' OR paid_minor = 0),
  CONSTRAINT invoices_void_parts CHECK (
    (status = 'void') = (voided_at IS NOT NULL)
    AND (voided_at IS NULL) = (voided_by IS NULL)
    AND (voided_at IS NULL) = (void_reason IS NULL)
  ),
  CONSTRAINT invoices_void_is_unpaid CHECK (status <> 'void' OR paid_minor = 0),
  CONSTRAINT invoices_pdf_parts CHECK ((pdf_state = 'ready') = (pdf_document_id IS NOT NULL))
);

CREATE INDEX invoices_client_idx ON invoices (client_id, created_at DESC, id DESC);
CREATE INDEX invoices_case_idx ON invoices (case_id, created_at DESC, id DESC)
  WHERE case_id IS NOT NULL;
CREATE INDEX invoices_list_idx ON invoices (created_at DESC, id DESC);
CREATE INDEX invoices_status_idx ON invoices (status, payment_status);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  position integer NOT NULL CHECK (position > 0),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor BETWEEN 0 AND 1000000000000),
  line_total_minor bigint NOT NULL CHECK (line_total_minor BETWEEN 0 AND 1000000000000),
  created_at timestamptz NOT NULL,
  CONSTRAINT invoice_items_line_total CHECK (line_total_minor = quantity * unit_amount_minor),
  CONSTRAINT invoice_items_position_key UNIQUE (invoice_id, position)
);

-- ---------------------------------------------------------------------------
-- Payments and reversals (TD-506, TD-507, TD-508)
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  receipt_number text NOT NULL UNIQUE CHECK (receipt_number ~ '^RCP-[0-9]{5,}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  method text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'cheque', 'card', 'other')),
  received_on date NOT NULL,
  reference text NOT NULL DEFAULT '' CHECK (length(reference) <= 120),
  recorded_by uuid NOT NULL REFERENCES users (id),
  receipt_pdf_state text NOT NULL DEFAULT 'pending' CHECK (
    receipt_pdf_state IN ('none', 'pending', 'ready', 'failed')
  ),
  receipt_document_id uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT payments_receipt_pdf_parts CHECK (
    (receipt_pdf_state = 'ready') = (receipt_document_id IS NOT NULL)
  )
);

CREATE INDEX payments_invoice_idx ON payments (invoice_id, created_at, id);

CREATE TABLE payment_reversals (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments (id),
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reversed_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL
);

CREATE INDEX payment_reversals_payment_idx ON payment_reversals (payment_id, created_at, id);
CREATE INDEX payment_reversals_invoice_idx ON payment_reversals (invoice_id);

-- ---------------------------------------------------------------------------
-- Stored billing PDFs (TD-504, TD-507)
-- ---------------------------------------------------------------------------

-- Separate from `documents` so a billing PDF is never listed, checked off, or
-- reconciled as a client upload, and never reachable by a role that can read
-- documents but not billing. The provider's external item ID is the durable
-- reference, exactly as for uploaded documents.
CREATE TABLE billing_documents (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('invoice', 'receipt')),
  invoice_id uuid NOT NULL REFERENCES invoices (id),
  payment_id uuid REFERENCES payments (id),
  client_id uuid NOT NULL REFERENCES clients (id),
  case_id uuid REFERENCES tax_cases (id),
  provider_type text NOT NULL CHECK (provider_type IN ('onedrive', 'fake')),
  external_item_id text NOT NULL CHECK (length(external_item_id) BETWEEN 1 AND 512),
  external_drive_id text CHECK (external_drive_id IS NULL OR length(external_drive_id) <= 512),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  CONSTRAINT billing_documents_kind_payment CHECK ((kind = 'receipt') = (payment_id IS NOT NULL)),
  CONSTRAINT billing_documents_external_item_key UNIQUE (provider_type, external_item_id)
);

CREATE UNIQUE INDEX billing_documents_invoice_pdf_key ON billing_documents (invoice_id)
  WHERE kind = 'invoice';
CREATE UNIQUE INDEX billing_documents_receipt_pdf_key ON billing_documents (payment_id)
  WHERE kind = 'receipt';

ALTER TABLE invoices
  ADD CONSTRAINT invoices_pdf_document_fk FOREIGN KEY (pdf_document_id)
  REFERENCES billing_documents (id);
ALTER TABLE payments
  ADD CONSTRAINT payments_receipt_document_fk FOREIGN KEY (receipt_document_id)
  REFERENCES billing_documents (id);

CREATE TRIGGER billing_documents_append_only
  BEFORE UPDATE OR DELETE ON billing_documents
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_append_only_mutation();

CREATE TRIGGER payment_reversals_append_only
  BEFORE UPDATE OR DELETE ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION taxdesk_guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_client uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices are never deleted; void them instead'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.case_id IS NOT NULL THEN
    SELECT client_id INTO case_client FROM tax_cases WHERE id = NEW.case_id;
    IF case_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'an invoice''s case must belong to the same client'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'an invoice starts as a draft'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an invoice''s client, case, currency, and creation facts are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'a void invoice cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'finalized' THEN
    IF NEW.status NOT IN ('finalized', 'void') THEN
      RAISE EXCEPTION 'a finalized invoice can only be voided'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
      OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
      OR NEW.due_date IS DISTINCT FROM OLD.due_date
      OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
      OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
      OR NEW.notes IS DISTINCT FROM OLD.notes
      OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
      OR NEW.finalized_by IS DISTINCT FROM OLD.finalized_by THEN
      RAISE EXCEPTION 'a finalized invoice''s number, dates, and amounts are immutable'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'finalized' AND NEW.invoice_number IS NULL THEN
    RAISE EXCEPTION 'finalizing an invoice needs its number'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_invoice();

-- Line items change only while the invoice is a draft.
CREATE FUNCTION taxdesk_guard_invoice_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT status INTO parent_status FROM invoices WHERE id = parent_id;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'line items are frozen once an invoice is finalized or void'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'a line item cannot move to another invoice'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER invoice_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_invoice_item();

-- Payments are append-only; only the receipt-PDF columns may change.
CREATE FUNCTION taxdesk_guard_payment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invoice_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are never deleted; reverse them instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO invoice_status FROM invoices WHERE id = NEW.invoice_id;
    IF invoice_status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'payments can only be recorded against a finalized invoice'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.method IS DISTINCT FROM OLD.method
    OR NEW.received_on IS DISTINCT FROM OLD.received_on
    OR NEW.reference IS DISTINCT FROM OLD.reference
    OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a recorded payment is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_payment();

-- A reversal belongs to its payment's invoice.
CREATE FUNCTION taxdesk_guard_payment_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payment_invoice uuid;
BEGIN
  SELECT invoice_id INTO payment_invoice FROM payments WHERE id = NEW.payment_id;
  IF payment_invoice IS DISTINCT FROM NEW.invoice_id THEN
    RAISE EXCEPTION 'a reversal must name its payment''s invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_reversals_guard
  BEFORE INSERT ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_payment_reversal();

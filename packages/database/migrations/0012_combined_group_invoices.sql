-- TaxDesk migration 0012: combined group invoices (Epic 5, TD-511; ADR 0010).
--
-- A combined invoice is addressed to a group head (`invoices.client_id`) and
-- has no invoice-level case. Each line names the client it is for (the head
-- or a member of the head) and optionally one of that client's cases. At
-- finalization each line's client code and display name are copied onto the
-- line; lines are frozen once the invoice is finalized (migration 0008), so a
-- later group or name change never alters a finalized invoice or its PDF.
--
-- Invariants enforced here as well as in the API:
--   * `billing_mode` is `individual` (the default; every existing invoice) or
--     `combined`, and never changes;
--   * a combined invoice has no invoice-level case;
--   * lines of an individual invoice name no client, case, or snapshot, and
--     the 0008 rule that an invoice's case belongs to its client is unchanged;
--   * every line of a combined invoice names a client that is the head or a
--     member of the head, and its case (when set) belongs to that client;
--   * finalizing a combined invoice rechecks every line's client under a
--     share lock on the client rows, so it serializes with a concurrent group
--     change, and requires every line's snapshot.
--
-- Existing invoices become `individual` and existing lines have no client, so
-- no backfill is needed.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

ALTER TABLE invoices
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'individual'
    CHECK (billing_mode IN ('individual', 'combined')),
  ADD CONSTRAINT invoices_combined_has_no_case CHECK (billing_mode <> 'combined' OR case_id IS NULL);

ALTER TABLE invoice_items
  ADD COLUMN client_id uuid REFERENCES clients (id),
  ADD COLUMN case_id uuid REFERENCES tax_cases (id),
  ADD COLUMN client_code_snapshot text,
  ADD COLUMN client_name_snapshot text,
  ADD CONSTRAINT invoice_items_case_needs_client CHECK (case_id IS NULL OR client_id IS NOT NULL),
  ADD CONSTRAINT invoice_items_snapshot_parts CHECK (
    (client_code_snapshot IS NULL) = (client_name_snapshot IS NULL)
    AND (client_code_snapshot IS NULL OR client_id IS NOT NULL)
  ),
  ADD CONSTRAINT invoice_items_snapshot_lengths CHECK (
    client_code_snapshot IS NULL
    OR (length(client_code_snapshot) BETWEEN 1 AND 32 AND length(client_name_snapshot) BETWEEN 1 AND 200)
  );

-- Duplicate-billing warnings and the invoice list's case filter find lines by case.
CREATE INDEX invoice_items_case_idx ON invoice_items (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX invoice_items_client_idx ON invoice_items (client_id) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Invoice guard: the 0008 rules plus the billing mode and the combined-invoice
-- recheck at finalization.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION taxdesk_guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_client uuid;
  head_parent uuid;
  bad_lines integer;
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
    OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an invoice''s client, case, currency, billing mode, and creation facts are immutable'
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

  IF OLD.status = 'draft' AND NEW.status = 'finalized' AND NEW.billing_mode = 'combined' THEN
    -- Share-lock the head and every line client, so a group change that has
    -- not committed yet is waited for and then seen.
    SELECT parent_client_id INTO head_parent FROM clients WHERE id = NEW.client_id FOR SHARE;
    IF head_parent IS NOT NULL THEN
      RAISE EXCEPTION 'a combined invoice is addressed to a group head'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_combined_group';
    END IF;
    PERFORM 1 FROM clients c
      WHERE c.id IN (SELECT it.client_id FROM invoice_items it WHERE it.invoice_id = NEW.id)
      ORDER BY c.id
      FOR SHARE;
    SELECT count(*) INTO bad_lines
    FROM invoice_items it
    LEFT JOIN clients c ON c.id = it.client_id
    WHERE it.invoice_id = NEW.id
      AND (
        it.client_id IS NULL
        OR it.client_code_snapshot IS NULL
        OR (c.id <> NEW.client_id AND c.parent_client_id IS DISTINCT FROM NEW.client_id)
      );
    IF bad_lines > 0 THEN
      RAISE EXCEPTION 'every line of a combined invoice must be for the group head or a current member, with its client snapshot'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_combined_group';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Line guard: the 0008 draft-only rule plus the combined-invoice line rules.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION taxdesk_guard_invoice_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_mode text;
  parent_client uuid;
  parent_id uuid;
  line_client_parent uuid;
  case_client uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT status, billing_mode, client_id INTO parent_status, parent_mode, parent_client
  FROM invoices WHERE id = parent_id;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'line items are frozen once an invoice is finalized or void'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'a line item cannot move to another invoice'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF parent_mode = 'individual' THEN
    IF NEW.client_id IS NOT NULL OR NEW.case_id IS NOT NULL OR NEW.client_code_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'only a combined invoice names a client on its lines'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_items_combined_line';
    END IF;
    RETURN NEW;
  END IF;

  -- Combined invoice.
  IF NEW.client_id IS NULL THEN
    RAISE EXCEPTION 'every line of a combined invoice names its client'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_items_combined_line';
  END IF;
  IF NEW.client_id <> parent_client THEN
    SELECT parent_client_id INTO line_client_parent FROM clients WHERE id = NEW.client_id;
    IF line_client_parent IS DISTINCT FROM parent_client THEN
      RAISE EXCEPTION 'a combined invoice line is for the group head or a member of the group'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_items_combined_line';
    END IF;
  END IF;
  IF NEW.case_id IS NOT NULL THEN
    SELECT client_id INTO case_client FROM tax_cases WHERE id = NEW.case_id;
    IF case_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'a combined invoice line''s case must belong to the line''s client'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_items_combined_line';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

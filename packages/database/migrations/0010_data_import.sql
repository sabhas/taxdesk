-- TaxDesk migration 0010: data import (Epic 7, TD-701–TD-705).
--
-- Adds the administrator-only `imports.manage` permission and the two tables
-- behind a CSV import:
--   * import_batches: one uploaded file, its SHA-256 checksum (unique among
--     batches that are not discarded), the dry-run plan counts, and the commit
--     state with its idempotency key;
--   * import_batch_rows: one planned row each, with row-level error codes, a
--     possible-duplicate decision and its reason, and after commit the
--     outcome and the created/updated record (source-row lineage).
--
-- The file itself is never stored, and rows hold no cell values: errors are
-- column names with fixed codes, so plaintext CNIC/NTN, names, and contact
-- details never reach these tables.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'imports.manage', 'Validate, review, and commit CSV data imports.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'imports.manage'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

CREATE SEQUENCE import_batch_code_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

-- ---------------------------------------------------------------------------
-- Batches
-- ---------------------------------------------------------------------------

CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  batch_code text NOT NULL UNIQUE CHECK (batch_code ~ '^IMP-[0-9]{5,}$'),
  kind text NOT NULL CHECK (kind IN ('clients', 'cases', 'opening_balances')),
  template_id text NOT NULL CHECK (template_id IN ('clients.v1', 'cases.v1', 'opening_balances.v1')),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 5000),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  status text NOT NULL
    CHECK (status IN ('validated', 'blocked', 'committing', 'committed', 'discarded')),
  plan_create integer NOT NULL DEFAULT 0 CHECK (plan_create >= 0),
  plan_update integer NOT NULL DEFAULT 0 CHECK (plan_update >= 0),
  plan_skip integer NOT NULL DEFAULT 0 CHECK (plan_skip >= 0),
  plan_review integer NOT NULL DEFAULT 0 CHECK (plan_review >= 0),
  plan_error integer NOT NULL DEFAULT 0 CHECK (plan_error >= 0),
  -- Opening balances only: the sum of the file's amounts.
  source_amount_minor bigint CHECK (source_amount_minor IS NULL OR source_amount_minor >= 0),
  validated_at timestamptz NOT NULL,
  commit_idempotency_key text CHECK (commit_idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  commit_started_at timestamptz,
  commit_started_by uuid REFERENCES users (id),
  committed_at timestamptz,
  committed_by uuid REFERENCES users (id),
  discarded_at timestamptz,
  discarded_by uuid REFERENCES users (id),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT import_batches_plan_total
    CHECK (plan_create + plan_update + plan_skip + plan_review + plan_error = row_count),
  CONSTRAINT import_batches_commit_columns CHECK (
    (status IN ('committing', 'committed')) =
      (commit_idempotency_key IS NOT NULL AND commit_started_at IS NOT NULL
        AND commit_started_by IS NOT NULL)
  ),
  CONSTRAINT import_batches_committed_columns CHECK (
    (status = 'committed') = (committed_at IS NOT NULL AND committed_by IS NOT NULL)
  ),
  CONSTRAINT import_batches_discarded_columns CHECK (
    (status = 'discarded') = (discarded_at IS NOT NULL AND discarded_by IS NOT NULL)
  ),
  -- A batch with errors or undecided rows can never be committed.
  CONSTRAINT import_batches_commit_needs_clean_plan CHECK (
    status NOT IN ('committing', 'committed') OR (plan_error = 0 AND plan_review = 0)
  )
);

-- The same file can be open in only one batch at a time; discard a batch to
-- upload its file again.
CREATE UNIQUE INDEX import_batches_source_unique
  ON import_batches (source_checksum) WHERE status <> 'discarded';
CREATE INDEX import_batches_created_idx ON import_batches (created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Rows (plan, decision, outcome, lineage)
-- ---------------------------------------------------------------------------

CREATE TABLE import_batch_rows (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES import_batches (id),
  kind text NOT NULL CHECK (kind IN ('clients', 'cases', 'opening_balances')),
  -- Spreadsheet row number: the header is row 1, the first data row is row 2.
  row_number integer NOT NULL CHECK (row_number >= 2),
  external_ref text CHECK (external_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  action text NOT NULL CHECK (action IN ('create', 'update', 'skip', 'review', 'error')),
  reason_code text CHECK (reason_code ~ '^[A-Z][A-Z_]*$'),
  -- Array of {column, code, message}; never cell values.
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  match_entity_type text CHECK (match_entity_type IN ('client', 'tax_case', 'invoice')),
  match_entity_id uuid,
  match_code text CHECK (length(match_code) BETWEEN 1 AND 40),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  decision text CHECK (decision IN ('create', 'skip')),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_by uuid REFERENCES users (id),
  decided_at timestamptz,
  outcome text CHECK (outcome IN ('created', 'updated', 'skipped', 'failed')),
  outcome_code text CHECK (outcome_code ~ '^[A-Z][A-Z_]*$'),
  entity_type text CHECK (entity_type IN ('client', 'tax_case', 'invoice')),
  entity_id uuid,
  entity_code text CHECK (length(entity_code) BETWEEN 1 AND 40),
  committed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT import_batch_rows_unique UNIQUE (batch_id, row_number),
  CONSTRAINT import_batch_rows_match_columns CHECK (
    (match_entity_id IS NULL) = (match_entity_type IS NULL)
    AND (match_entity_id IS NULL) = (match_code IS NULL)
  ),
  CONSTRAINT import_batch_rows_decision_columns CHECK (
    (decision IS NULL) = (decision_reason IS NULL)
    AND (decision IS NULL) = (decided_by IS NULL)
    AND (decision IS NULL) = (decided_at IS NULL)
  ),
  CONSTRAINT import_batch_rows_decision_only_on_review CHECK (decision IS NULL OR action = 'review'),
  CONSTRAINT import_batch_rows_outcome_columns CHECK (
    (outcome IS NULL) = (committed_at IS NULL)
    AND (entity_id IS NULL) = (entity_type IS NULL)
    AND (entity_id IS NULL) = (entity_code IS NULL)
    AND (outcome NOT IN ('created', 'updated') OR entity_id IS NOT NULL)
    AND (outcome IS NOT NULL OR entity_id IS NULL)
  ),
  CONSTRAINT import_batch_rows_error_has_errors CHECK (
    action <> 'error' OR jsonb_array_length(errors) > 0 OR reason_code IS NOT NULL
  )
);

-- An external reference creates at most one record per kind, deployment-wide.
CREATE UNIQUE INDEX import_batch_rows_created_lineage
  ON import_batch_rows (kind, external_ref) WHERE outcome = 'created';
-- Lineage lookups: the newest committed link for a reference.
CREATE INDEX import_batch_rows_lineage_idx
  ON import_batch_rows (kind, external_ref, committed_at DESC) WHERE entity_id IS NOT NULL;
CREATE INDEX import_batch_rows_entity_idx ON import_batch_rows (entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX import_batch_rows_pending_idx
  ON import_batch_rows (batch_id, row_number) WHERE outcome IS NULL;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

CREATE FUNCTION taxdesk_guard_import_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import batches are never deleted; discard them instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.batch_code <> OLD.batch_code OR NEW.kind <> OLD.kind
     OR NEW.template_id <> OLD.template_id OR NEW.source_checksum <> OLD.source_checksum
     OR NEW.size_bytes <> OLD.size_bytes OR NEW.row_count <> OLD.row_count
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an import batch''s file facts are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('committed', 'discarded') THEN
    RAISE EXCEPTION 'a committed or discarded import batch cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'committing' AND NEW.status NOT IN ('committing', 'committed') THEN
    RAISE EXCEPTION 'a committing import batch can only finish committing'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.commit_idempotency_key IS NOT NULL
     AND NEW.commit_idempotency_key IS DISTINCT FROM OLD.commit_idempotency_key THEN
    RAISE EXCEPTION 'an import batch''s commit key is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER import_batches_guard
  BEFORE UPDATE OR DELETE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_import_batch();

CREATE FUNCTION taxdesk_guard_import_batch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import rows are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.batch_id <> OLD.batch_id OR NEW.row_number <> OLD.row_number OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'an import row cannot move'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Lineage is permanent: once a row has an outcome it never changes.
  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'a committed import row is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER import_batch_rows_guard
  BEFORE UPDATE OR DELETE ON import_batch_rows
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_import_batch_row();

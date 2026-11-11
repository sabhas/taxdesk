-- TaxDesk migration 0006: tax-case workflow (Epic 3).
--
-- Adds the service catalog, versioned workflow/checklist templates, tax cases
-- with their template snapshots, the append-only status history, and case
-- checklist items. One deployment serves one firm, so nothing here carries a
-- tenant column.
--
-- Invariants enforced here as well as in the API:
--   * a published workflow version is immutable and cannot be deleted;
--   * case status history is append-only;
--   * a case's status changes only by pointing at a new status-history row
--     whose from/to match the change (no direct status updates);
--   * a case's client, service snapshot, and workflow snapshot never change;
--   * only completed or cancelled cases can be archived, archived cases are
--     read-only, and cases are never deleted;
--   * a reviewer never verifies a checklist item they completed.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'services.manage', 'Configure service types and workflow/checklist templates.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'services.manage'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'services.manage'
]::text[])
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Workflow templates and versions (TD-302, TD-303)
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_templates (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);

CREATE UNIQUE INDEX workflow_templates_name_key ON workflow_templates (lower(name));

-- `definition` holds the statuses, transitions, and checklist items validated
-- by the shared `WorkflowDefinitionSchema`. Workflow and checklist are one
-- document, so they are always published together.
CREATE TABLE workflow_template_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES workflow_templates (id),
  version_number integer NOT NULL CHECK (version_number > 0),
  state text NOT NULL CHECK (state IN ('draft', 'published')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  published_at timestamptz,
  published_by uuid REFERENCES users (id),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT workflow_template_versions_number_key UNIQUE (template_id, version_number),
  CONSTRAINT workflow_template_versions_published_parts CHECK (
    (state = 'published') = (published_at IS NOT NULL)
  )
);

-- At most one draft per template; the draft becomes the next version number.
CREATE UNIQUE INDEX workflow_template_versions_one_draft
  ON workflow_template_versions (template_id) WHERE state = 'draft';

CREATE FUNCTION taxdesk_reject_published_workflow_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'Published workflow version % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_template_versions_published_immutable
  BEFORE UPDATE OR DELETE ON workflow_template_versions
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_published_workflow_change();

-- ---------------------------------------------------------------------------
-- Service types (TD-301)
-- ---------------------------------------------------------------------------

CREATE TABLE service_types (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  -- Integer minor units (paisa).
  default_fee_minor bigint NOT NULL CHECK (default_fee_minor BETWEEN 0 AND 1000000000000),
  -- Days after the case is opened (firm calendar) for the suggested due date.
  default_deadline_offset_days integer NOT NULL CHECK (default_deadline_offset_days BETWEEN 0 AND 730),
  duplicate_case_policy text NOT NULL CHECK (duplicate_case_policy IN ('warn', 'block')),
  default_workflow_template_id uuid REFERENCES workflow_templates (id),
  created_by uuid REFERENCES users (id),
  -- Archive state. Archived services keep their cases and cannot be chosen
  -- for new cases.
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);

CREATE UNIQUE INDEX service_types_active_name_key ON service_types (lower(name))
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Tax cases (TD-304 onward)
-- ---------------------------------------------------------------------------

-- Case codes (`TC-00001`) are never reused, even after a rolled-back create.
CREATE SEQUENCE tax_case_code_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE tax_cases (
  id uuid PRIMARY KEY,
  case_code text NOT NULL UNIQUE CHECK (case_code ~ '^TC-[0-9]{5,}$'),
  client_id uuid NOT NULL REFERENCES clients (id),
  service_type_id uuid NOT NULL REFERENCES service_types (id),
  -- Service values at the time the case was opened (TD-301 history rule).
  service_name text NOT NULL CHECK (length(btrim(service_name)) BETWEEN 1 AND 120),
  service_fee_minor bigint NOT NULL CHECK (service_fee_minor >= 0),
  tax_year integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  workflow_version_id uuid NOT NULL REFERENCES workflow_template_versions (id),
  workflow_template_id uuid NOT NULL REFERENCES workflow_templates (id),
  workflow_template_name text NOT NULL CHECK (length(btrim(workflow_template_name)) BETWEEN 1 AND 120),
  workflow_version_number integer NOT NULL CHECK (workflow_version_number > 0),
  -- Statuses and transitions copied from the version (checklist items are
  -- copied into case_checklist_items).
  workflow_snapshot jsonb NOT NULL CHECK (jsonb_typeof(workflow_snapshot) = 'object'),
  current_status_key text NOT NULL CHECK (current_status_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  current_status_name text NOT NULL CHECK (length(btrim(current_status_name)) BETWEEN 1 AND 60),
  current_status_kind text NOT NULL
    CHECK (current_status_kind IN ('open', 'filed', 'completed', 'cancelled')),
  current_status_history_id uuid NOT NULL,
  due_date date NOT NULL,
  primary_consultant_user_id uuid REFERENCES users (id),
  reviewer_user_id uuid REFERENCES users (id),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  created_by uuid REFERENCES users (id),
  -- Archive timestamp.
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT tax_cases_distinct_reviewer CHECK (
    reviewer_user_id IS NULL OR reviewer_user_id IS DISTINCT FROM primary_consultant_user_id
  ),
  CONSTRAINT tax_cases_archive_closed_only CHECK (
    deleted_at IS NULL OR current_status_kind IN ('completed', 'cancelled')
  )
);

CREATE INDEX tax_cases_client_idx ON tax_cases (client_id);
CREATE INDEX tax_cases_duplicate_idx ON tax_cases (client_id, service_type_id, tax_year);
CREATE INDEX tax_cases_consultant_idx ON tax_cases (primary_consultant_user_id);
CREATE INDEX tax_cases_reviewer_idx ON tax_cases (reviewer_user_id);
CREATE INDEX tax_cases_queue_idx ON tax_cases (due_date, id) WHERE deleted_at IS NULL;

CREATE TABLE case_status_history (
  id uuid PRIMARY KEY,
  -- Deferred so a case and its initial history row can be written in one
  -- transaction (history first, then the case that points at it).
  case_id uuid NOT NULL REFERENCES tax_cases (id) DEFERRABLE INITIALLY DEFERRED,
  from_status_key text,
  from_status_name text,
  to_status_key text NOT NULL CHECK (to_status_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  to_status_name text NOT NULL CHECK (length(btrim(to_status_name)) BETWEEN 1 AND 60),
  to_status_kind text NOT NULL CHECK (to_status_kind IN ('open', 'filed', 'completed', 'cancelled')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  actor_user_id uuid REFERENCES users (id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL,
  CONSTRAINT case_status_history_from_parts CHECK (
    (from_status_key IS NULL) = (from_status_name IS NULL)
  )
);

CREATE INDEX case_status_history_case_idx ON case_status_history (case_id, id);

CREATE TRIGGER case_status_history_append_only
  BEFORE UPDATE OR DELETE ON case_status_history
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_append_only_mutation();

ALTER TABLE tax_cases
  ADD CONSTRAINT tax_cases_current_status_history_fk
  FOREIGN KEY (current_status_history_id) REFERENCES case_status_history (id);

-- The only way to change a case's status is to append a history row and point
-- the case at it. The row must belong to the case, be its newest history row,
-- and describe exactly the change being made.
CREATE FUNCTION taxdesk_guard_tax_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry case_status_history%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tax cases are archived, never deleted' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Archived tax case % is read-only', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.case_code IS DISTINCT FROM OLD.case_code
       OR NEW.service_type_id IS DISTINCT FROM OLD.service_type_id
       OR NEW.service_name IS DISTINCT FROM OLD.service_name
       OR NEW.service_fee_minor IS DISTINCT FROM OLD.service_fee_minor
       OR NEW.tax_year IS DISTINCT FROM OLD.tax_year
       OR NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
       OR NEW.workflow_template_id IS DISTINCT FROM OLD.workflow_template_id
       OR NEW.workflow_template_name IS DISTINCT FROM OLD.workflow_template_name
       OR NEW.workflow_version_number IS DISTINCT FROM OLD.workflow_version_number
       OR NEW.workflow_snapshot IS DISTINCT FROM OLD.workflow_snapshot
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'Tax case snapshot fields are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.current_status_key IS NOT DISTINCT FROM OLD.current_status_key
       AND NEW.current_status_name IS NOT DISTINCT FROM OLD.current_status_name
       AND NEW.current_status_kind IS NOT DISTINCT FROM OLD.current_status_kind
       AND NEW.current_status_history_id IS NOT DISTINCT FROM OLD.current_status_history_id THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT * INTO entry FROM case_status_history WHERE id = NEW.current_status_history_id;
  IF NOT FOUND
     OR entry.case_id <> NEW.id
     OR entry.to_status_key <> NEW.current_status_key
     OR entry.to_status_name <> NEW.current_status_name
     OR entry.to_status_kind <> NEW.current_status_kind
     OR EXISTS (
       SELECT 1 FROM case_status_history later
       WHERE later.case_id = NEW.id AND later.id > entry.id
     ) THEN
    RAISE EXCEPTION 'A tax case status changes only through a recorded transition'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND entry.from_status_key IS NOT NULL THEN
    RAISE EXCEPTION 'A new tax case starts from its initial status'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       entry.id = OLD.current_status_history_id
       OR entry.from_status_key IS DISTINCT FROM OLD.current_status_key
     ) THEN
    RAISE EXCEPTION 'A tax case status changes only through a recorded transition'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_cases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_cases
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_tax_case();

CREATE TABLE case_checklist_items (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES tax_cases (id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  item_key text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  document_type text CHECK (length(document_type) BETWEEN 1 AND 80),
  required boolean NOT NULL,
  review_required boolean NOT NULL,
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 2000),
  state text NOT NULL CHECK (state IN ('open', 'completed', 'verified', 'rejected')),
  completed_by uuid REFERENCES users (id),
  completed_at timestamptz,
  preparer_comment text NOT NULL DEFAULT '' CHECK (length(preparer_comment) <= 1000),
  reviewed_by uuid REFERENCES users (id),
  reviewed_at timestamptz,
  review_comment text NOT NULL DEFAULT '' CHECK (length(review_comment) <= 1000),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT case_checklist_items_position_key UNIQUE (case_id, position),
  CONSTRAINT case_checklist_items_key UNIQUE (case_id, item_key),
  CONSTRAINT case_checklist_items_state_parts CHECK (
    CASE state
      WHEN 'open' THEN completed_at IS NULL AND reviewed_at IS NULL
      WHEN 'completed' THEN completed_at IS NOT NULL AND reviewed_at IS NULL
      ELSE completed_at IS NOT NULL AND reviewed_at IS NOT NULL
    END
  ),
  CONSTRAINT case_checklist_items_completed_parts CHECK (
    (completed_at IS NULL) = (completed_by IS NULL)
  ),
  CONSTRAINT case_checklist_items_reviewed_parts CHECK (
    (reviewed_at IS NULL) = (reviewed_by IS NULL)
  ),
  CONSTRAINT case_checklist_items_review_only_when_required CHECK (
    review_required OR state IN ('open', 'completed')
  ),
  -- Separation of duties: a reviewer never verifies their own work.
  CONSTRAINT case_checklist_items_distinct_reviewer CHECK (
    reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM completed_by
  )
);

CREATE TRIGGER case_checklist_items_no_delete
  BEFORE DELETE ON case_checklist_items
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_append_only_mutation();

-- TaxDesk migration 0007: provider-neutral document storage (Epic 4).
--
-- Adds the deployment's storage connection (encrypted provider tokens), the
-- short-lived OAuth state for an administrator's consent flow, resumable
-- upload sessions, document metadata, and reconciliation runs. File bytes
-- never enter PostgreSQL; documents keep the provider's external item ID as
-- their durable reference.
--
-- Invariants enforced here as well as in the API:
--   * at most one storage connection row exists (singleton index);
--   * a connected row always carries ciphertext and its key version, and a
--     disconnected row never keeps a token;
--   * documents are never hard-deleted and never move to another client;
--   * one completed upload creates at most one document (idempotency);
--   * reconciliation runs are append-only.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'storage.manage', 'Connect document storage and run reconciliation.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'storage.manage'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Storage connection (TD-402, TD-403, TD-404)
-- ---------------------------------------------------------------------------

CREATE TABLE storage_connections (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true CHECK (singleton),
  provider_type text NOT NULL CHECK (provider_type IN ('onedrive', 'fake')),
  status text NOT NULL CHECK (
    status IN ('not_connected', 'healthy', 'reconnect_required', 'unavailable')
  ),
  health_reason text CHECK (
    health_reason IS NULL OR health_reason IN (
      'consent_revoked', 'refresh_failed', 'provider_unavailable',
      'rate_limited', 'folder_unavailable', 'not_configured'
    )
  ),
  external_drive_id text CHECK (external_drive_id IS NULL OR length(external_drive_id) <= 512),
  external_root_folder_id text CHECK (
    external_root_folder_id IS NULL OR length(external_root_folder_id) <= 512
  ),
  account_label text CHECK (account_label IS NULL OR length(account_label) <= 200),
  -- AES-256-GCM ciphertext of the provider credential JSON (access token,
  -- refresh token, expiry). The key is a deployment secret, never stored here.
  token_ciphertext text,
  token_key_version integer CHECK (token_key_version IS NULL OR token_key_version > 0),
  access_token_expires_at timestamptz,
  connected_at timestamptz,
  connected_by uuid REFERENCES users (id),
  last_checked_at timestamptz,
  last_refreshed_at timestamptz,
  disconnected_at timestamptz,
  disconnected_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT storage_connections_token_parts CHECK (
    (token_ciphertext IS NULL) = (token_key_version IS NULL)
  ),
  CONSTRAINT storage_connections_connected_has_token CHECK (
    status = 'not_connected' OR token_ciphertext IS NOT NULL
  ),
  CONSTRAINT storage_connections_disconnected_has_no_token CHECK (
    status <> 'not_connected' OR token_ciphertext IS NULL
  )
);

CREATE UNIQUE INDEX storage_connections_singleton_key ON storage_connections (singleton);

-- One row per consent attempt. Only the SHA-256 digest of the random state is
-- stored; the PKCE verifier is encrypted with the storage token key.
CREATE TABLE storage_oauth_states (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (length(state_hash) BETWEEN 16 AND 128),
  code_verifier_ciphertext text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  provider_type text NOT NULL CHECK (provider_type IN ('onedrive', 'fake')),
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT storage_oauth_states_expiry CHECK (expires_at > created_at)
);

CREATE INDEX storage_oauth_states_expires_idx ON storage_oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- Documents (TD-405, TD-407, TD-408, TD-409)
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients (id),
  case_id uuid REFERENCES tax_cases (id),
  checklist_item_id uuid REFERENCES case_checklist_items (id),
  document_type text NOT NULL CHECK (length(btrim(document_type)) BETWEEN 1 AND 80),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  content_type text NOT NULL CHECK (content_type IN (
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv'
  )),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  provider_type text NOT NULL CHECK (provider_type IN ('onedrive', 'fake')),
  -- The durable, provider-neutral reference. Never a path.
  external_item_id text NOT NULL CHECK (length(external_item_id) BETWEEN 1 AND 512),
  external_drive_id text CHECK (external_drive_id IS NULL OR length(external_drive_id) <= 512),
  -- The provider's parent folder ID at upload, used to detect moves.
  external_parent_id text CHECK (external_parent_id IS NULL OR length(external_parent_id) <= 512),
  external_etag text CHECK (external_etag IS NULL OR length(external_etag) <= 512),
  verification_state text NOT NULL CHECK (
    verification_state IN ('pending', 'verified', 'rejected', 'missing_provider')
  ),
  verification_note text CHECK (verification_note IS NULL OR length(verification_note) <= 1000),
  verified_by uuid REFERENCES users (id),
  verified_at timestamptz,
  provider_state text NOT NULL CHECK (provider_state IN ('present', 'missing', 'moved')),
  last_reconciled_at timestamptz,
  upload_id uuid NOT NULL UNIQUE,
  uploaded_by uuid NOT NULL REFERENCES users (id),
  uploaded_at timestamptz NOT NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT documents_checklist_needs_case CHECK (checklist_item_id IS NULL OR case_id IS NOT NULL),
  CONSTRAINT documents_review_parts CHECK (
    (verification_state IN ('verified', 'rejected')) = (verified_at IS NOT NULL)
  ),
  CONSTRAINT documents_deleted_parts CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  CONSTRAINT documents_external_item_key UNIQUE (provider_type, external_item_id)
);

CREATE INDEX documents_client_idx ON documents (client_id, uploaded_at DESC, id DESC);
CREATE INDEX documents_case_idx ON documents (case_id, uploaded_at DESC, id DESC)
  WHERE case_id IS NOT NULL;
CREATE INDEX documents_checklist_item_idx ON documents (checklist_item_id)
  WHERE checklist_item_id IS NOT NULL;
CREATE INDEX documents_reconcile_idx ON documents (id) WHERE deleted_at IS NULL;

-- Documents are never hard-deleted, never change client or storage reference,
-- and a case link must point at a case of the same client.
CREATE FUNCTION taxdesk_guard_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  case_client uuid;
  item_case uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documents are never deleted; soft-delete with deleted_at'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.client_id IS DISTINCT FROM OLD.client_id
      OR NEW.provider_type IS DISTINCT FROM OLD.provider_type
      OR NEW.external_item_id IS DISTINCT FROM OLD.external_item_id
      OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
      OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
      OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
      RAISE EXCEPTION 'a document''s client, storage reference, and upload facts are immutable'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.case_id IS NOT NULL THEN
    SELECT client_id INTO case_client FROM tax_cases WHERE id = NEW.case_id;
    IF case_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'a document''s case must belong to the same client'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.checklist_item_id IS NOT NULL THEN
    SELECT case_id INTO item_case FROM case_checklist_items WHERE id = NEW.checklist_item_id;
    IF item_case IS DISTINCT FROM NEW.case_id THEN
      RAISE EXCEPTION 'a document''s checklist item must belong to its case'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_document();

-- ---------------------------------------------------------------------------
-- Upload sessions (TD-406)
-- ---------------------------------------------------------------------------

CREATE TABLE document_uploads (
  id uuid PRIMARY KEY,
  -- The document ID is assigned up front so the provider path is stable.
  document_id uuid NOT NULL UNIQUE,
  client_id uuid NOT NULL REFERENCES clients (id),
  case_id uuid REFERENCES tax_cases (id),
  checklist_item_id uuid REFERENCES case_checklist_items (id),
  document_type text NOT NULL CHECK (length(btrim(document_type)) BETWEEN 1 AND 80),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 180),
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  provider_type text NOT NULL CHECK (provider_type IN ('onedrive', 'fake')),
  -- The provider's upload-session handle (a pre-authenticated URL for
  -- OneDrive), encrypted with the storage token key.
  session_ciphertext text,
  session_key_version integer CHECK (session_key_version IS NULL OR session_key_version > 0),
  next_offset bigint NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  state text NOT NULL CHECK (state IN ('active', 'completed', 'cancelled', 'expired', 'failed')),
  -- Filled once the provider reports every byte received.
  external_item_id text CHECK (external_item_id IS NULL OR length(external_item_id) <= 512),
  created_by uuid NOT NULL REFERENCES users (id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT document_uploads_offset_within_size CHECK (next_offset <= size_bytes),
  CONSTRAINT document_uploads_session_parts CHECK (
    (session_ciphertext IS NULL) = (session_key_version IS NULL)
  ),
  CONSTRAINT document_uploads_completed_parts CHECK (
    (state = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT document_uploads_request_key UNIQUE (created_by, request_id)
);

CREATE INDEX document_uploads_active_idx ON document_uploads (expires_at) WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- Reconciliation runs (TD-410)
-- ---------------------------------------------------------------------------

CREATE TABLE storage_reconciliation_runs (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('completed', 'failed')),
  started_by uuid NOT NULL REFERENCES users (id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  connection_status text NOT NULL CHECK (
    connection_status IN ('not_connected', 'healthy', 'reconnect_required', 'unavailable')
  ),
  checked_count integer NOT NULL CHECK (checked_count >= 0),
  present_count integer NOT NULL CHECK (present_count >= 0),
  missing_count integer NOT NULL CHECK (missing_count >= 0),
  moved_count integer NOT NULL CHECK (moved_count >= 0),
  recovered_count integer NOT NULL CHECK (recovered_count >= 0),
  next_action text NOT NULL CHECK (
    next_action IN ('none', 'review_missing_documents', 'reconnect_storage', 'retry_later')
  ),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  CONSTRAINT storage_reconciliation_runs_order CHECK (finished_at >= started_at)
);

CREATE INDEX storage_reconciliation_runs_recent_idx
  ON storage_reconciliation_runs (started_at DESC, id DESC);

CREATE TRIGGER storage_reconciliation_runs_append_only
  BEFORE UPDATE OR DELETE ON storage_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_append_only_mutation();

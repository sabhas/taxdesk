-- TaxDesk migration 0002: identity, sessions, MFA, and audit.
--
-- One deployment serves exactly one firm, so no table carries an
-- organization/tenant column. Roles and permissions are reference data with a
-- stable textual key; the app resolves them by key and never trusts a
-- client-supplied role, permission, owner, or scope.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

CREATE TABLE firm_settings (
  id uuid PRIMARY KEY,
  firm_name text NOT NULL CHECK (length(btrim(firm_name)) BETWEEN 1 AND 160),
  timezone text NOT NULL CHECK (length(btrim(timezone)) BETWEEN 1 AND 64),
  bootstrap_completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);

-- A deployment has exactly one firm row. The constant expression index makes a
-- second row impossible even if two bootstrap commands race.
CREATE UNIQUE INDEX firm_settings_singleton ON firm_settings ((true));

CREATE TABLE roles (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 240),
  is_builtin boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(email_normalized)),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  password_hash text,
  password_hash_version integer CHECK (password_hash_version IS NULL OR password_hash_version > 0),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'deactivated')),
  mfa_enrolled_at timestamptz,
  last_login_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  -- Invited users have no password yet; activation sets both atomically.
  CHECK ((status = 'invited') = (password_hash IS NULL)),
  CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL))
);

CREATE INDEX users_status_idx ON users (status);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL,
  assigned_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  mfa_verified_at timestamptz,
  revoked_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (last_seen_at >= created_at)
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE activation_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('activation', 'password_reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX activation_tokens_user_idx ON activation_tokens (user_id, created_at DESC);

CREATE TABLE login_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX login_challenges_user_idx ON login_challenges (user_id, created_at DESC);

CREATE TABLE mfa_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0)
);

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, code_hash)
);

CREATE INDEX mfa_recovery_codes_unused_idx
  ON mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;

CREATE TABLE auth_attempts (
  id uuid PRIMARY KEY,
  account_key text NOT NULL CHECK (account_key ~ '^[0-9a-f]{64}$'),
  network_key text NOT NULL CHECK (network_key ~ '^[0-9a-f]{64}$'),
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX auth_attempts_account_idx ON auth_attempts (account_key, created_at DESC);
CREATE INDEX auth_attempts_network_idx ON auth_attempts (network_key, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 80),
  entity_id uuid,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, id DESC);

-- Audit history is append-only: even a mistaken operator statement cannot
-- rewrite or erase an event. Corrections are new events.
CREATE FUNCTION taxdesk_reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION taxdesk_reject_append_only_mutation();

-- Built-in roles. These rows are idempotent reference data; the application
-- also calls `seedBuiltInRoles()` so a database restored without this migration
-- history cannot be used with an empty role catalog.
INSERT INTO roles (id, key, name, description, is_builtin, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'administrator', 'Administrator', 'User, integration, setting, audit, and full-record control.', true, now(), now(), 1),
  (gen_random_uuid(), 'manager', 'Manager', 'All case and client visibility, assignments, review, and reports.', true, now(), now(), 1),
  (gen_random_uuid(), 'consultant', 'Consultant', 'Assigned case and client work, checklists, and documents.', true, now(), now(), 1),
  (gen_random_uuid(), 'billing', 'Billing', 'Invoices, payments, receipts, and billing reports.', true, now(), now(), 1),
  (gen_random_uuid(), 'read_only', 'Read-only', 'Explicitly permitted records without mutation.', true, now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'firm.settings.read', 'Read firm settings.', now(), now(), 1),
  (gen_random_uuid(), 'firm.settings.manage', 'Update firm settings.', now(), now(), 1),
  (gen_random_uuid(), 'users.read', 'Read staff user records.', now(), now(), 1),
  (gen_random_uuid(), 'users.manage', 'Invite, deactivate, reactivate, and reset staff users.', now(), now(), 1),
  (gen_random_uuid(), 'audit.read', 'Read the append-only audit history.', now(), now(), 1),
  (gen_random_uuid(), 'clients.read', 'Read client records.', now(), now(), 1),
  (gen_random_uuid(), 'clients.manage', 'Create and update client records.', now(), now(), 1),
  (gen_random_uuid(), 'cases.read_all', 'Read every tax case.', now(), now(), 1),
  (gen_random_uuid(), 'cases.read_assigned', 'Read tax cases assigned to the signed-in user.', now(), now(), 1),
  (gen_random_uuid(), 'cases.manage', 'Create and update tax cases.', now(), now(), 1),
  (gen_random_uuid(), 'cases.assign', 'Assign staff to tax cases.', now(), now(), 1),
  (gen_random_uuid(), 'documents.read', 'Read document metadata and contents.', now(), now(), 1),
  (gen_random_uuid(), 'documents.manage', 'Upload, verify, and replace documents.', now(), now(), 1),
  (gen_random_uuid(), 'billing.read', 'Read invoices, payments, and receipts.', now(), now(), 1),
  (gen_random_uuid(), 'billing.manage', 'Create and finalize invoices and record payments.', now(), now(), 1),
  (gen_random_uuid(), 'reports.read', 'Read operational and billing reports.', now(), now(), 1),
  (gen_random_uuid(), 'dashboard.read', 'Read the operational dashboard.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'firm.settings.read',
  'firm.settings.manage',
  'users.read',
  'users.manage',
  'audit.read',
  'clients.read',
  'clients.manage',
  'cases.read_all',
  'cases.read_assigned',
  'cases.manage',
  'cases.assign',
  'documents.read',
  'documents.manage',
  'billing.read',
  'billing.manage',
  'reports.read',
  'dashboard.read'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'firm.settings.read',
  'clients.read',
  'clients.manage',
  'cases.read_all',
  'cases.manage',
  'cases.assign',
  'documents.read',
  'documents.manage',
  'billing.read',
  'reports.read',
  'dashboard.read'
]::text[])
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'firm.settings.read',
  'clients.read',
  'cases.read_assigned',
  'documents.read',
  'documents.manage',
  'dashboard.read'
]::text[])
WHERE r.key = 'consultant'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'firm.settings.read',
  'clients.read',
  'cases.read_all',
  'billing.read',
  'billing.manage',
  'reports.read',
  'dashboard.read'
]::text[])
WHERE r.key = 'billing'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'firm.settings.read',
  'clients.read',
  'cases.read_all',
  'documents.read',
  'billing.read',
  'reports.read',
  'dashboard.read'
]::text[])
WHERE r.key = 'read_only'
ON CONFLICT DO NOTHING;

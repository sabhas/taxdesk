-- TaxDesk migration 0005: client master records (Epic 2).
--
-- One deployment serves one firm, so clients carry no tenant column. National
-- identifiers (CNIC, NTN) are stored three ways, never in plaintext:
--   *_ciphertext   AES-256-GCM ciphertext under a deployment secret (key
--                  version in identifier_key_version) for future authorized use;
--   *_blind_index  HMAC-SHA-256 under a separate deployment secret, unique per
--                  deployment, for exact duplicate blocking and exact search;
--   *_masked       the display form, keeping only the last four digits.
--
-- `clients.read_all` splits client visibility: holders see every client; a
-- consultant (`clients.read` only) sees clients assigned to them.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'clients.read_all', 'View every client record, not only assigned clients.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'clients.read_all'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'clients.read_all'
]::text[])
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'clients.read_all'
]::text[])
WHERE r.key = 'billing'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'clients.read_all'
]::text[])
WHERE r.key = 'read_only'
ON CONFLICT DO NOTHING;

-- Client codes (`CL-00001`) come from this sequence and are never reused, even
-- when a transaction that drew a number rolls back.
CREATE SEQUENCE client_code_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE clients (
  id uuid PRIMARY KEY,
  client_code text NOT NULL UNIQUE CHECK (client_code ~ '^CL-[0-9]{5,}$'),
  client_type text NOT NULL CHECK (client_type IN ('individual', 'business')),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 200),
  normalized_display_name text NOT NULL CHECK (length(normalized_display_name) BETWEEN 1 AND 200),
  cnic_ciphertext text,
  cnic_blind_index text CHECK (cnic_blind_index ~ '^[0-9a-f]{64}$'),
  cnic_masked text CHECK (length(cnic_masked) BETWEEN 7 AND 15),
  ntn_ciphertext text,
  ntn_blind_index text CHECK (ntn_blind_index ~ '^[0-9a-f]{64}$'),
  ntn_masked text CHECK (length(ntn_masked) BETWEEN 7 AND 15),
  identifier_key_version integer CHECK (identifier_key_version > 0),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  assigned_manager_user_id uuid REFERENCES users (id),
  created_by uuid REFERENCES users (id),
  -- Archive state. Archived clients are hidden from default search and
  -- selection but keep every relationship and their full audit history.
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT clients_cnic_parts CHECK (
    (cnic_ciphertext IS NULL) = (cnic_blind_index IS NULL)
    AND (cnic_ciphertext IS NULL) = (cnic_masked IS NULL)
  ),
  CONSTRAINT clients_ntn_parts CHECK (
    (ntn_ciphertext IS NULL) = (ntn_blind_index IS NULL)
    AND (ntn_ciphertext IS NULL) = (ntn_masked IS NULL)
  ),
  CONSTRAINT clients_identifier_key_version CHECK (
    identifier_key_version IS NOT NULL
    OR (cnic_ciphertext IS NULL AND ntn_ciphertext IS NULL)
  ),
  CONSTRAINT clients_business_has_no_cnic CHECK (
    client_type <> 'business' OR cnic_ciphertext IS NULL
  )
);

-- Exact identifier duplicates are blocked across the whole deployment,
-- including archived clients, so a restore can never create a duplicate.
CREATE UNIQUE INDEX clients_cnic_blind_index_key ON clients (cnic_blind_index)
  WHERE cnic_blind_index IS NOT NULL;
CREATE UNIQUE INDEX clients_ntn_blind_index_key ON clients (ntn_blind_index)
  WHERE ntn_blind_index IS NOT NULL;

CREATE INDEX clients_normalized_name_idx ON clients (normalized_name);
CREATE INDEX clients_normalized_display_name_idx ON clients (normalized_display_name);
CREATE INDEX clients_manager_idx ON clients (assigned_manager_user_id);
CREATE INDEX clients_listing_idx ON clients ((lower(display_name)) COLLATE "C", id);

CREATE TABLE client_contacts (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients (id),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  relationship text CHECK (length(relationship) <= 80),
  email text CHECK (length(email) <= 254),
  email_normalized text CHECK (length(email_normalized) <= 254),
  phone text CHECK (length(phone) <= 32),
  phone_normalized text CHECK (phone_normalized ~ '^[0-9]{7,15}$'),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CONSTRAINT client_contacts_channel CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT client_contacts_email_parts CHECK ((email IS NULL) = (email_normalized IS NULL)),
  CONSTRAINT client_contacts_phone_parts CHECK ((phone IS NULL) = (phone_normalized IS NULL)),
  CONSTRAINT client_contacts_position_key UNIQUE (client_id, position)
);

CREATE UNIQUE INDEX client_contacts_one_primary ON client_contacts (client_id) WHERE is_primary;
CREATE INDEX client_contacts_email_idx ON client_contacts (email_normalized)
  WHERE email_normalized IS NOT NULL;
CREATE INDEX client_contacts_phone_idx ON client_contacts (phone_normalized)
  WHERE phone_normalized IS NOT NULL;

-- Per-record activity history reads audit events by entity, newest first.
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, id DESC);

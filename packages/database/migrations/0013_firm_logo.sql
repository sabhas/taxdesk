-- TaxDesk migration 0013: firm logo on invoices and receipts (Epic 5, TD-512; ADR 0012).
--
-- An administrator uploads one firm logo. It is printed on invoice and receipt
-- PDFs generated afterwards; PDFs already stored are never regenerated.
--
-- The logo is small (at most 512 KiB) and is firm configuration, not client
-- material, so it lives in the database next to `firm_settings` rather than in
-- client document storage. It sits in its own table so the settings row that
-- most requests read never carries the image bytes.
--
-- Invariants enforced here as well as in the API:
--   * at most one logo, belonging to the single firm row;
--   * PNG or JPEG only (the only formats the PDF renderer can embed);
--   * `byte_size` and `sha256` always describe the stored bytes, so the digest
--     recorded in the audit trail identifies exactly what was printed.
--
-- A logo change bumps `firm_settings.version`, so the settings ETag covers it.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

CREATE TABLE firm_logos (
  firm_settings_id uuid PRIMARY KEY REFERENCES firm_settings (id),
  content_type text NOT NULL
    CONSTRAINT firm_logos_content_type_check CHECK (content_type IN ('image/png', 'image/jpeg')),
  byte_size integer NOT NULL
    CONSTRAINT firm_logos_byte_size_check CHECK (byte_size BETWEEN 1 AND 524288),
  sha256 text NOT NULL
    CONSTRAINT firm_logos_sha256_format_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL,
  updated_by_user_id uuid NOT NULL REFERENCES users (id),
  updated_at timestamptz NOT NULL,
  CONSTRAINT firm_logos_byte_size_matches_check CHECK (byte_size = octet_length(bytes)),
  CONSTRAINT firm_logos_sha256_matches_check CHECK (sha256 = encode(sha256(bytes), 'hex'))
);

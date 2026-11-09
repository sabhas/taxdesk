-- TaxDesk migration 0004: sign in with a username instead of an email.
--
-- TaxDesk sends no email: activation and reset links are shared by an
-- administrator and recovery is an offline CLI. The email address was only an
-- identifier, so it is replaced by a permanent, lowercase username and the
-- email columns are removed.
--
-- Existing rows get a username derived from the email local part, with
-- non-allowed characters removed and duplicates suffixed (-2, -3, ...), so the
-- migration is safe on a database that already holds users.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

ALTER TABLE users ADD COLUMN username text;

WITH base AS (
  SELECT
    id,
    created_at,
    regexp_replace(
      regexp_replace(split_part(email_normalized, '@', 1), '[^a-z0-9._-]', '', 'g'),
      '^[^a-z0-9]+|[^a-z0-9]+$',
      '',
      'g'
    ) AS candidate
  FROM users
),
sized AS (
  SELECT
    id,
    created_at,
    CASE
      WHEN length(candidate) < 3 THEN 'user' || substr(md5(id::text), 1, 6)
      ELSE left(candidate, 27)
    END AS candidate
  FROM base
),
ranked AS (
  SELECT
    id,
    -- Trimming to 27 characters may leave a trailing separator; strip it again.
    regexp_replace(candidate, '[^a-z0-9]+$', '', 'g') AS candidate,
    row_number() OVER (PARTITION BY candidate ORDER BY created_at, id) AS position
  FROM sized
)
UPDATE users
SET username = CASE
  WHEN ranked.position = 1 THEN ranked.candidate
  ELSE ranked.candidate || '-' || ranked.position::text
END
FROM ranked
WHERE users.id = ranked.id;

ALTER TABLE users
  ALTER COLUMN username SET NOT NULL,
  ADD CONSTRAINT users_username_format
    CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$'),
  ADD CONSTRAINT users_username_key UNIQUE (username);

ALTER TABLE users
  DROP COLUMN email,
  DROP COLUMN email_normalized;

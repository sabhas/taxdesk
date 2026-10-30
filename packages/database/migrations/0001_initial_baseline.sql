-- TaxDesk migration 0001: initial baseline.
--
-- The migration ledger (`taxdesk_migration_ledger`) is bootstrapped by the
-- runner itself (see src/migrations/ledger.ts) because it must exist before any
-- migration can be recorded. This baseline gives the forward-only history a
-- versioned, checksummed starting point that every later migration builds on.
--
-- Never edit this file after it has been applied. Add a new migration instead.

SELECT 1;

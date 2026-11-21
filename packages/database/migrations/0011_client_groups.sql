-- TaxDesk migration 0011: client groups (Epic 2, TD-207; ADR 0010).
--
-- A group is a parent client (the group head) and the clients linked to it.
-- `clients.parent_client_id` is a nullable self-reference; there is no group
-- record and no group name. Groups are one level deep:
--   * a client cannot be its own parent (check constraint);
--   * a parent cannot itself have a parent, and a client with members cannot
--     be given a parent (trigger).
-- The API enforces the same rule under row locks. The trigger is the backstop:
-- it locks the parent row, so two concurrent writes that would together build a
-- two-level chain are serialized and the second one fails.
--
-- Archiving a parent or a member keeps the link; the API refuses an archived
-- client as a new parent. Existing clients have no parent, so no backfill is
-- needed. Combined group invoices (TD-511) come in a later migration.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

ALTER TABLE clients
  ADD COLUMN parent_client_id uuid REFERENCES clients (id),
  ADD CONSTRAINT clients_not_own_parent CHECK (parent_client_id IS NULL OR parent_client_id <> id);

-- Group filters and member lists read members by their head.
CREATE INDEX clients_parent_idx ON clients (parent_client_id) WHERE parent_client_id IS NOT NULL;

CREATE FUNCTION taxdesk_guard_client_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_of_parent uuid;
BEGIN
  IF NEW.parent_client_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_client_id IS NOT DISTINCT FROM OLD.parent_client_id THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_client_id = NEW.id THEN
    RAISE EXCEPTION 'a client cannot be its own parent client'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'clients_not_own_parent';
  END IF;
  -- Locking the parent serializes this write with any write that gives the
  -- parent a parent of its own, which holds the parent's row lock.
  SELECT parent_client_id INTO parent_of_parent
  FROM clients
  WHERE id = NEW.parent_client_id
  FOR UPDATE;
  IF parent_of_parent IS NOT NULL THEN
    RAISE EXCEPTION 'a client group is one level deep: the parent client has a parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'clients_flat_group';
  END IF;
  IF EXISTS (SELECT 1 FROM clients WHERE parent_client_id = NEW.id) THEN
    RAISE EXCEPTION 'a client group is one level deep: the client has group members'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'clients_flat_group';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_flat_group
  BEFORE INSERT OR UPDATE OF parent_client_id ON clients
  FOR EACH ROW EXECUTE FUNCTION taxdesk_guard_client_group();

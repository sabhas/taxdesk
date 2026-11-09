-- TaxDesk migration 0003: consultant assigned case work.
--
-- Consultants own the case work they are assigned to (checklists, case
-- updates, documents) but must not create or update any other case. The
-- existing `cases.manage` permission is firm-wide, so assignment-scoped work
-- needs its own permission. The API grants a mutation only when the actor holds
-- `cases.manage` and can see the record, or holds `cases.work_assigned` and is
-- assigned to it.
--
-- Never edit this file after it has been applied anywhere. Add a compensating
-- forward migration instead.

INSERT INTO permissions (id, key, description, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 'cases.work_assigned', 'Update tax cases assigned to the signed-in user.', now(), now(), 1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'cases.work_assigned'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = ANY (ARRAY[
  'cases.work_assigned'
]::text[])
WHERE r.key = 'consultant'
ON CONFLICT DO NOTHING;

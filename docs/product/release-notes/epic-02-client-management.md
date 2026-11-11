---
title: "Release note: Epic 2 client management"
status: draft
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-10
related:
  - ../prd/epic-02-client-management.md
  - ../../adr/0004-client-identifier-protection-and-visibility.md
---

# Release note: Epic 2 client management (TD-201–TD-206)

Draft until staging demonstration and Sprint Review acceptance.

## What users can do

- **Clients area** in the navigation for every role. Administrators, managers,
  billing, and read-only users see all clients; consultants see the clients
  they are the assigned manager of.
- **Create clients** (administrators and managers) as an individual (CNIC
  required, NTN optional) or a business (NTN required), with a display name,
  up to 10 contacts with one primary, notes, and an assigned manager. Codes
  such as `CL-00001` are assigned automatically.
- **Duplicate checks before creation.** A matching CNIC or NTN is blocked and
  links to the existing client, even if it is archived. A matching email,
  phone, or name shows a warning; a manager or administrator may continue with
  a written reason, which is recorded in the client's history.
- **Edit safely.** If a colleague saved first, the form keeps your input and
  shows it beside the latest saved values, so you can save yours on top or
  discard it.
- **Search and filter** by client code, name (ignoring case, punctuation, and
  suffixes like "Pvt. Ltd."), phone (national or international form), email,
  or an exact CNIC/NTN; filter by type, manager, and status; page through
  results.
- **Archive and restore** with a confirmation. Archived clients are hidden from
  the default list and cannot be edited until restored.
- **Activity history** on each client: who created, changed, archived, or
  restored it and which fields changed. Values are never shown; identifiers
  appear masked.

CNIC and NTN are always shown masked (`•••••-••••567-1`). There is no way to
view a full identifier in this release.

## Data changes

- Migration `0005_client_management.sql` (forward-only): tables `clients` and
  `client_contacts`, sequence `client_code_seq`, permission `clients.read_all`
  granted to administrator, manager, billing, and read-only, and an audit-event
  index for per-record history.
- No existing rows are changed. Consultants' effective client access narrows
  from "all" (no clients existed before) to "assigned".

## Operational actions

1. Generate two **different** keys per environment and store them as Worker
   secrets (see [environments](../../technical/environments.md#secret-sets)):

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='   # run twice: one value per key
   pnpm exec wrangler secret put CLIENT_DATA_ENCRYPTION_KEY --env staging
   pnpm exec wrangler secret put CLIENT_IDENTIFIER_INDEX_KEY --env staging
   ```

   Keep an offline escrow copy with the other deployment secrets. Losing the
   index key breaks duplicate blocking and identifier search; losing the
   encryption key loses the stored ciphertext. Without the keys, creating a
   client returns `503` and nothing is stored in plaintext.
2. Apply migration `0005` before deploying the API (`pnpm db:migrate`, run by
   the staging delivery workflow).
3. Use synthetic client data only until TD-709 and TD-710 pass.

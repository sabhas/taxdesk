---
title: "ADR 0004: Client identifier protection and assignment-scoped client visibility"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-10
related:
  - ../product/prd/epic-02-client-management.md
  - ../technical/data-model.md
  - ../technical/environments.md
---

# ADR 0004: Client identifier protection and assignment-scoped client visibility

Status is `proposed` until the Product Owner accepts Epic 2 in Sprint Review.

## Context

Epic 2 introduces the client master record. Two of its decisions change the
security posture and public contract:

1. CNIC and NTN are national tax identifiers. The data model requires
   "encrypted ciphertext for display and an HMAC blind index for exact
   duplicate detection", and the Definition of Done forbids exposing an
   unmasked identifier in logs, errors, fixtures, or tests. The PRD also asks
   for exact search by identifier.
2. TD-202 restricts client access "by role and assignment rules". Every
   built-in role held `clients.read`, so the permission catalog alone could not
   express that a consultant sees only assigned clients.

## Decision

### Identifier storage

- An identifier is normalized to digits by the shared contract
  (`normalizeCnic`, `normalizeNtn`) and stored three ways, never in plaintext:
  - `*_ciphertext`: AES-256-GCM under the `CLIENT_DATA_ENCRYPTION_KEY`
    deployment secret, with `identifier_key_version`;
  - `*_blind_index`: HMAC-SHA-256 over `taxdesk.client.<kind>:<digits>` under a
    separate `CLIENT_IDENTIFIER_INDEX_KEY` secret. Partial unique indexes on
    each blind index block exact duplicates across the whole deployment,
    including archived clients;
  - `*_masked`: the display form keeping only the last four digits
    (`•••••-••••567-1`).
- The two keys must differ. The index key can match duplicates but cannot
  decrypt; the encryption key is unused by every read path today.
- **Identifiers are write-only through the API.** Responses, activity history,
  and audit metadata carry only the masked form. There is no "reveal" endpoint;
  a future one needs its own permission, audit event, and ADR.
- Search by identifier is exact only: the search term is normalized and its
  blind index compared. Partial identifiers never match.
- Without both keys, writes that need them and identifier search fail closed
  with `503 SERVICE_UNAVAILABLE`; masked reads keep working. Plaintext is never
  stored as a fallback.

### Client visibility

- A new permission, `clients.read_all`, is granted to administrator, manager,
  billing, and read-only (migration `0005`). Consultants keep `clients.read`
  only and see clients whose **assigned manager** is the signed-in user.
  Epic 3 may widen this to clients of cases assigned to the consultant.
- For a user without `clients.read_all`, a missing client and someone else's
  client both return the same `403`, so identifiers cannot be probed.
- `clients.manage` (administrator, manager) creates, edits, archives, restores,
  runs the duplicate preview, and is the only permission that may override a
  non-exact duplicate warning.

### Duplicate handling

- Exact CNIC/NTN matches are always blocked (`409 CLIENT_IDENTIFIER_EXISTS`),
  including when an override reason is supplied.
- Email, phone (compared in normalized international form), and normalized
  name matches are warnings (`409 CLIENT_DUPLICATE_WARNING`). A manager or
  administrator may proceed with a reason of 10–500 characters; the decision
  is a `client.duplicate_override` audit event with the reason and matched
  client codes.

## Consequences

- Two new Worker secrets per environment. Losing the encryption key loses the
  ciphertext (masked values and duplicate blocking keep working); losing the
  index key breaks duplicate blocking and identifier search until every blind
  index is recomputed from decrypted ciphertext. Both belong in the recovery
  runbook alongside `MFA_ENCRYPTION_KEY`.
- Key rotation needs a re-encryption/re-index job keyed by
  `identifier_key_version`; a single version column covers both identifiers.
- A changed consultant visibility rule is a role-matrix change; the shared
  catalog, the SQL seed, and the drift test move together.

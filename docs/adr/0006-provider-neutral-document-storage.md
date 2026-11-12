---
title: "ADR 0006: Provider-neutral document storage through the Worker"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-11
related:
  - ../product/prd/epic-04-document-storage.md
  - ../product/sprint-1-review-notes.md
  - ../technical/data-model.md
  - ../technical/architecture.md
---

# ADR 0006: Provider-neutral document storage through the Worker

Status is `proposed` until the Product Owner accepts Epic 4 in Sprint Review.

## Context

Epic 4 stores client documents in the firm's Microsoft OneDrive (Personal)
account, proven feasible by the TD-005 spike. Several requirements change the
security posture or a public contract:

1. The architecture says the browser never connects to OneDrive or Microsoft
   Graph. Graph upload sessions and download links are pre-authenticated URLs
   that a browser could use directly.
2. TD-402 requires provider tokens to be encrypted with deployment secrets and
   never reach a browser, a log, or an API response.
3. TD-403 limits the connection to administrators. No permission in the
   catalog covered integration settings.
4. TD-408 says checklist progress changes "only through verified required
   links", and the PRD lists `missing-provider` as a verification state.
5. TD-409 needs a rule for who may restore a deleted document.

## Decision

1. **Every byte goes through the Worker.** The browser uploads 5 MiB chunks
   (a multiple of OneDrive's 320 KiB rule) to `PUT
   /api/v1/documents/uploads/{id}/content?offset=` and the Worker forwards each
   chunk to the provider's upload session. Downloads stream through `GET
   /api/v1/documents/{id}/content` with `Content-Disposition: attachment`,
   `Cache-Control: private, no-store`, `nosniff`, and a sandbox CSP. Upload
   session URLs are encrypted at rest and never returned. The cost is Worker
   bandwidth and request time; the benefit is that authorization, deactivation,
   and audit are re-checked on every request and no pre-authenticated URL
   leaves the server.
2. **`DocumentStorageProvider` is the only door to storage.** Domain services,
   routes, and repositories depend on `storage/provider.ts`; only
   `storage/provider-factory.ts` imports the OneDrive adapter, and a boundary
   test fails if anything else does. Business records keep the provider's
   external item ID (plus drive, parent, and ETag for reconciliation), never a
   path. Paths are derived once from stable values — client code, tax year,
   case ID, document ID — so a client rename never breaks access.
3. **Tokens are encrypted with a dedicated key.** Provider credentials are
   AES-256-GCM ciphertext under `STORAGE_TOKEN_ENCRYPTION_KEY` with a stored key
   version, separate from the MFA and client-identifier keys. OAuth uses the
   authorization code flow with PKCE (S256); only the SHA-256 digest of the
   state is stored, the verifier is encrypted, a state is single-use, expires
   after ten minutes, and must be completed by the administrator who started
   it. Microsoft redirects to a web page (`/settings/storage/callback`), not to
   the API: that navigation is cross-site, so the `SameSite=Strict` session
   cookie is not sent with it. The page strips the code from the address bar
   and posts it to `POST /api/v1/storage/connection/complete` from the app's
   own origin, where the session cookie and the Origin check apply. Refresh happens under a row lock so concurrent requests share one
   rotation.
4. **`storage.manage` is a new administrator-only permission.** It covers
   connect, reconnect, health check, disconnect, and reconciliation.
5. **Unhealthy storage stops new document work.** A revoked or expired grant
   (or credentials that can no longer be decrypted) marks the connection
   `reconnect_required`; uploads, opens, deletes, and restores then fail with
   `503` until an administrator reconnects, and administrators see a reconnect
   call to action. A transient provider failure (timeout, `5xx`, throttling)
   marks the connection `unavailable` but does not block it: the next
   operation is still attempted and its success marks the connection healthy
   again. Existing metadata stays readable either way.
6. **Verification states are `pending`, `verified`, `rejected`, and
   `missing_provider`.** Reconciliation sets `missing_provider` (and
   `provider_state = missing`) when an item is gone, and returns it to
   `pending` if the item reappears. Moves are recorded as `provider_state =
   moved` without changing verification. Records and history are never
   deleted.
7. **Document-typed required checklist items need a verified document.**
   Completing such an item requires at least one linked, non-deleted,
   `verified` document. When the last such document stops qualifying (rejected,
   reset, unlinked, deleted, or missing), an open case's item is reopened in the
   same transaction and audited.
8. **Document access follows the record it belongs to.** Reading needs
   `documents.read` plus access to the client (all of that client's documents,
   including those on cases the user is not assigned to) or assignment to the
   document's case (that case's documents). Uploading, editing, and deleting
   need `documents.manage` and the right to work the case (or manage the
   client, for client-level documents); they are refused on completed,
   cancelled, or archived cases. Reviewing needs the case reviewer role or
   `cases.manage` (or `clients.manage` for client-level documents). Deleting is
   a soft delete plus provider trash; restoring needs `documents.manage` with
   `cases.manage` or `clients.manage`, and succeeds only while the provider
   object is still recoverable. Authorization and deactivation are re-checked on
   every download, and each download is audited.

## Consequences

- Upload throughput is bounded by the Worker; 250 MiB at 5 MiB per request is
  50 requests, each retried and resumable from the server's offset.
- A new deployment secret (`STORAGE_TOKEN_ENCRYPTION_KEY`) and Microsoft app
  registration values (`ONEDRIVE_CLIENT_ID`, optional `ONEDRIVE_CLIENT_SECRET`,
  `ONEDRIVE_AUTHORITY`) are required per environment. Losing the storage key
  only forces an administrator to reconnect; document metadata is unaffected.
- Epic 3 behavior changes: a required checklist item with a document type can
  no longer be completed without a verified document.
- Moving to another provider means writing a new adapter and a migration of
  external IDs; no business code changes.

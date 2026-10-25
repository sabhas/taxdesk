---
title: TaxDesk technical architecture
status: accepted
version: 1.0
owners: [engineering]
last_reviewed: 2026-10-25
related:
  - ../taxdesk-implementation-plan.md
  - data-model.md
---

# Technical architecture

## System map

```text
React web application
        │ same-origin HTTPS requests
        ▼
Cloudflare Worker / Hono API
  ├── auth and organization scope
  ├── permission middleware
  ├── domain services
  ├── repositories ──────────────► Cloudflare D1
  ├── document storage port ─────► OneDrive adapter (first provider)
  └── audit, idempotency, logs
```

## Module boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Shared package | Zod contracts, IDs, errors, public DTOs | database access or secrets |
| Domain services | workflow, billing, authorization decisions | HTTP or React rendering |
| Repositories | D1 SQL and transaction boundaries | business-rule interpretation |
| API routes | authentication, input parsing, response mapping | balances or direct provider behavior |
| Web features | accessible forms, lists, state, user feedback | permission enforcement or financial calculations |
| Provider adapters | OneDrive/Graph protocol behavior | case or invoice business rules |

## Non-negotiable boundaries

- Organization scope comes from the authenticated membership, never the request body or route query.
- All money, workflow transitions, and mutable records are committed by the API.
- Every mutating request carries a request ID; material changes also produce an append-only audit event.
- Repositories are D1-specific, but service interfaces are database-agnostic.
- Document storage is accessed only through `DocumentStorageProvider`.
- Provider tokens and encryption keys remain Worker secrets and are never returned by APIs.
- All timestamps are stored in UTC; presentation uses the organization timezone.

## Deployment topology

- `development`, `staging`, and `production` each have separate Worker configuration, D1 database, secrets, and storage connection.
- Staging uses synthetic data only.
- Database migrations are forward-only and applied in CI before application deployment.
- Feature flags protect incomplete or pilot-only capabilities.
- Production recovery uses D1 Time Travel plus a separate encrypted daily export.

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
React web application on Cloudflare Pages
        │ same-origin HTTPS requests
        ▼
Cloudflare Worker / Hono API
  ├── auth and organization scope
  ├── permission middleware
  ├── domain services
  ├── repositories ──────────────► Hyperdrive ─────────► Managed PostgreSQL
  ├── document storage port ─────► OneDrive adapter (first provider)
  └── audit, idempotency, logs
```

## Module boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Shared package | Zod contracts, IDs, errors, public DTOs | database access or secrets |
| Domain services | workflow, billing, authorization decisions | HTTP or React rendering |
| Repositories | PostgreSQL queries and transaction boundaries | business-rule interpretation |
| API routes | authentication, input parsing, response mapping | balances or direct provider behavior |
| Web features | accessible forms, lists, state, user feedback | permission enforcement or financial calculations |
| Provider adapters | OneDrive/Graph protocol behavior | case or invoice business rules |

## Non-negotiable boundaries

- Organization scope comes from the authenticated membership, never the request body or route query.
- The web client never connects to PostgreSQL or provider integrations directly; it uses only the authenticated Worker API.
- All money, workflow transitions, and mutable records are committed by the API.
- Every mutating request carries a request ID; material changes also produce an append-only audit event.
- Repositories use PostgreSQL, but service interfaces are database-agnostic.
- Document storage is accessed only through `DocumentStorageProvider`.
- Provider tokens and encryption keys remain deployment secrets and are never returned by APIs.
- All timestamps are stored in UTC; presentation uses the organization timezone.

## Deployment topology

- Local development runs the React application and Worker API on the developer workstation against a dedicated managed development PostgreSQL database. The development database contains only synthetic data and is separate from staging and production.
- Production runs the React application on Cloudflare Pages and the Hono API on Cloudflare Workers. PostgreSQL is a separately managed production database.
- `development`, `staging`, and `production` each have separate configuration, PostgreSQL databases, secrets, and storage connections. Staging is an isolated deployment and uses synthetic data only.
- Hyperdrive manages pooled Worker-to-database connections. The managed database accepts only TLS connections using its least-privilege application credential; network access is restricted to approved Cloudflare connectivity whenever the provider supports it.
- Database migrations are forward-only and applied in CI before application deployment.
- Feature flags protect incomplete or pilot-only capabilities.
- The managed database must provide automated encrypted backups and point-in-time recovery. An encrypted, independent logical export is retained outside the database provider.
- Backup success, database recovery coverage, Worker health, Pages deployment health, and suspicious authentication activity are monitored and alert an operator on failure.

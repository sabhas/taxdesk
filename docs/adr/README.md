---
title: TaxDesk architecture decision records
status: accepted
version: 1.0
last_reviewed: 2026-10-25
---

# Architecture decision records

ADRs preserve decisions that are expensive to reverse. Once accepted, do not rewrite an ADR; create a later ADR that supersedes it.

The currently accepted decisions are documented in [the implementation plan](../taxdesk-implementation-plan.md): React on Cloudflare Pages, Hono on Cloudflare Workers with Hyperdrive and separate managed PostgreSQL databases for development, staging, and production, organization-scoped data, custom application login with MFA, and a provider-neutral document interface with OneDrive first.

When implementation begins, create separate ADRs for decisions that change cost, data isolation, security posture, or public contracts.

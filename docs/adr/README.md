---
title: TaxDesk architecture decision records
status: accepted
version: 1.0
last_reviewed: 2026-10-25
---

# Architecture decision records

ADRs preserve decisions that are expensive to reverse. Once accepted, do not rewrite an ADR; create a later ADR that supersedes it.

The currently accepted decisions are documented in [the implementation plan](../taxdesk-implementation-plan.md): React on Cloudflare Pages, Hono on Cloudflare Workers with Hyperdrive and separate managed PostgreSQL databases for development, staging, and production, one firm per deployment, custom application login with MFA, and a provider-neutral document interface with OneDrive first.

When implementation begins, create separate ADRs for decisions that change cost, data isolation, security posture, or public contracts.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-custom-identity-sessions-and-mfa.md) | Custom identity, opaque sessions, mandatory TOTP MFA, and declared route policies | accepted (sign-in identifier superseded by 0002) |
| [0002](0002-username-sign-in.md) | Sign in with a permanent username instead of an email | accepted |
| [0003](0003-ui-foundation.md) | shadcn/ui on Base UI and Tailwind CSS as the web UI foundation | accepted |
| [0004](0004-client-identifier-protection-and-visibility.md) | Client identifier protection and assignment-scoped client visibility | proposed |
| [0005](0005-case-workflow-integrity-and-authorization.md) | Tax-case workflow integrity and case authorization | proposed |

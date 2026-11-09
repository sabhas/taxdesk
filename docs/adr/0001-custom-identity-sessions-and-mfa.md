---
title: "ADR 0001: Custom identity, opaque sessions, mandatory TOTP MFA, and declared route policies"
status: accepted
version: 1.0
owners: [engineering]
last_reviewed: 2026-11-09
related:
  - ../product/prd/epic-01-identity-mfa-and-authorization.md
  - ../guides/administrator-recovery.md
  - ../technical/data-model.md
---

# ADR 0001: Custom identity, opaque sessions, mandatory TOTP MFA, and declared route policies

## Context

The implementation plan accepted custom application login with MFA for a
single-firm deployment. Epic 1 turns that into concrete security posture that
later epics depend on and that is expensive to change once real staff accounts
exist.

## Decision

1. **Accounts.** Staff accounts exist only through the offline bootstrap CLI or
   an administrator invitation. There is no public registration route. One
   deployment serves one firm; no table carries an organization scope.
2. **Passwords.** PBKDF2-HMAC-SHA-256 with a unique 16-byte salt per hash and a
   versioned encoding (`pbkdf2-sha256$<version>$<iterations>$<salt>$<hash>`).
   Version 1 uses 100,000 iterations, the highest count the Cloudflare Workers
   Web Crypto runtime accepts; hashes above it are rejected as invalid instead
   of failing at runtime. Valid logins on an older work factor are rehashed
   transparently. A stronger work factor needs a new algorithm version (for
   example a WebAssembly memory-hard KDF) through a superseding ADR.
3. **Sessions.** A 32-byte random opaque token in a `__Host-` cookie that is
   `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. PostgreSQL stores only
   the SHA-256 digest. Sessions expire after 30 minutes idle and 12 hours
   absolute. Password, MFA, role, and active-status changes revoke every
   session for the user.
4. **MFA.** TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) is mandatory: every
   route except sign-in, current session, logout, and enrollment returns
   `MFA_ENROLLMENT_REQUIRED` until enrollment is confirmed. TOTP secrets are
   encrypted with AES-256-GCM under the `MFA_ENCRYPTION_KEY` deployment secret;
   ten single-use recovery codes are stored as SHA-256 hashes.
5. **Login defenses.** Failures (password and second factor) are counted per
   hashed normalized account and per hashed network identity over 15 minutes.
   Five account or fifteen network failures require Cloudflare Turnstile;
   ten account or thirty network failures deny with `429` and `Retry-After`.
   A denied MFA challenge is burned. Missing Turnstile or MFA secrets fail
   closed with `503`, never open.
6. **Authorization.** Five built-in roles map to a fixed permission catalog
   shared by the SQL seed, API, and web app. Every `/api/v1` route declares one
   access policy through `protect()` (`public`, `session`, `self_service`,
   `permission`, or `self_or_permission`); that declaration is the route's only
   guard, and a registry test fails if any route lacks one. Case work uses
   `cases.manage` (any visible case) or `cases.work_assigned` (only assigned
   cases). Denials return the same `403 FORBIDDEN` whether or not the record
   exists.
7. **Recovery.** Lockout recovery is an offline CLI that needs deployment-level
   database access and writes audit events. There is no email-based reset in
   this epic; administrators share one-time 30-minute links out of band.

## Consequences

- Rotating `MFA_ENCRYPTION_KEY` requires a re-encryption step keyed by the stored
  `key_version`; losing the key forces every user through `disable-mfa`
  recovery.
- Account-keyed throttling lets an attacker who knows an email delay that
  user's sign-in for up to 15 minutes. Turnstile and network keys limit the
  cost; the trade-off favours brute-force resistance.
- Later epics add routes by declaring a policy and, when needed, a permission
  in a forward migration plus the shared catalog. The seed test keeps the two
  in sync.

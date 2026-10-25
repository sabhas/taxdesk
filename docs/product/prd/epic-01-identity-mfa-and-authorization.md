---
title: "Epic 1: Identity, MFA, and Authorization"
status: not_started
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
related:
  - ../roadmap.md
  - ../../technical/architecture.md
  - ../../technical/data-model.md
  - ../definition-of-done.md
---

# Epic 1: Identity, MFA, and Authorization

## Scope

Create custom TaxDesk accounts with role- and permission-based access, secure sessions, mandatory MFA, and administrator-managed user lifecycle.

**Out of scope:** public registration, social login, email delivery integration, active-session dashboard, custom role editor, and multi-firm onboarding.

## User roles

- **Administrator:** user, integration, setting, audit, and full-record control.
- **Manager:** all case/client visibility, assignments, review, and reports.
- **Consultant:** assigned case/client work, checklists, and documents.
- **Billing:** invoices, payments, receipts, and billing reports.
- **Read-only:** explicitly permitted records without mutation.

## Sprint 2 backlog — 20 points

### TD-101 — Firm and identity schema — 3 points

**User story:** As a platform owner, I want firm settings, users, roles, and permissions represented separately so that access is securely managed within a single-firm deployment.

- [ ] Add firm-settings, users, roles, permissions, role mappings, sessions, activation tokens, and audit-event tables.
- [ ] Seed the five built-in roles idempotently.
- [ ] Enforce role and permission checks for all authorization-relevant data.

### TD-102 — Initial administrator bootstrap — 3 points

**User story:** As the firm owner, I want to create the first administrator securely so that no default credential exists in source code.

- [ ] Provide an interactive CLI bootstrap command requiring explicit firm name, email, and password.
- [ ] Store only the versioned password hash and write an audit event.
- [ ] Refuse to bootstrap another initial administrator after setup completes.

### TD-103 — Password and session primitives — 3 points

**User story:** As a user, I want my credential and session protected so that a stolen database or browser history does not reveal access.

- [ ] Implement PBKDF2-HMAC-SHA-256 password hashing with unique salt and versioned work factor.
- [ ] Store only a hash of an opaque random session token.
- [ ] Use a Secure, HTTP-only, SameSite=Strict, `__Host-` cookie.
- [ ] Enforce 30-minute idle and 12-hour absolute session expiry.

### TD-104 — Login and logout — 5 points

**User story:** As an invited user, I want to sign in and out of TaxDesk so that I can access only my firm’s records.

- [ ] Validate email/password server-side with generic failure messages.
- [ ] Create a session after verified credentials and clear it on logout.
- [ ] Display loading, invalid credential, expired-session, and server-error states in the web application.
- [ ] Verify state-changing routes reject absent or expired sessions.

### TD-105 — Current-user context — 3 points

**User story:** As a signed-in user, I want the app to know my role and permissions so that navigation accurately reflects what I can do.

- [ ] Expose a minimal current-session endpoint with user, roles, and permissions.
- [ ] Load it once in the web application and gate navigation affordances.
- [ ] Treat browser navigation gates as convenience only; API authorization remains authoritative.

### TD-106 — Authorization middleware — 3 points

**User story:** As a firm, I want every protected request authorized by role and permission so that staff access is appropriately restricted.

- [ ] Attach authenticated user, roles, and permissions to request context.
- [ ] Reject requests lacking required permissions.
- [ ] Add tests for identifier guessing and nested-resource access.

## Sprint 3 backlog — 19 points

### TD-107 — TOTP MFA and recovery codes — 5 points

**User story:** As a user, I want MFA and recovery codes so that my account remains protected even if my password is exposed.

- [ ] Support TOTP enrollment, confirmation, challenge, disable with confirmation, and regeneration of recovery codes.
- [ ] Encrypt TOTP secrets and store recovery-code hashes only.
- [ ] Prevent access to production routes until MFA enrollment is complete.
- [ ] Permit each recovery code exactly once.

### TD-108 — Administrator user lifecycle — 4 points

**User story:** As an administrator, I want to invite, deactivate, reactivate, and reset users so that staff access stays current.

- [ ] Create one-time 30-minute activation/reset links without sending email automatically.
- [ ] Allow built-in role assignment and user deactivation/reactivation.
- [ ] Revoke all active sessions after password, MFA, role, or active-status change.
- [ ] Preserve audit history when a user is deactivated.

### TD-109 — Permission enforcement — 4 points

**User story:** As a manager, I want permissions enforced by the server so that users cannot elevate access through the browser.

- [ ] Require an explicit permission declaration on every protected route.
- [ ] Enforce ownership/assignment rules for consultant case work.
- [ ] Return consistent 401/403 Problem Details without disclosing protected records.
- [ ] Test every built-in role against representative routes.

### TD-110 — Authentication defenses — 3 points

**User story:** As a platform owner, I want resistance to common login attacks so that approved accounts remain available and private.

- [ ] Rate-limit by normalized account and network identity.
- [ ] Require verified Turnstile after repeated failures.
- [ ] Add CSP, security headers, Origin checks, and log redaction.

### TD-111 — Account recovery and security verification — 3 points

**User story:** As the last administrator, I want a documented recovery path so that the firm is not locked out.

- [ ] Provide an offline CLI recovery procedure requiring deployment-level access.
- [ ] Add browser tests for login, MFA, logout, expired session, deactivation, and permission denial.
- [ ] Publish an administrator recovery runbook.

## Exit criteria

- No public registration route exists.
- Every protected API route has tested permission enforcement.
- MFA is required before normal application access.
- User deactivation immediately invalidates existing sessions.

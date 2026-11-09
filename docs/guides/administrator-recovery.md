---
title: Administrator bootstrap and recovery runbook
status: accepted
version: 1.0
owners: [engineering, operations]
last_reviewed: 2026-11-09
related:
  - ../product/prd/epic-01-identity-mfa-and-authorization.md
  - ../technical/environments.md
  - ../adr/0001-custom-identity-sessions-and-mfa.md
---

# Administrator bootstrap and recovery runbook

TaxDesk has no public registration, no default credential, and no in-app
"forgot password" flow. The first administrator is created with an offline CLI,
and a locked-out administrator is recovered with another offline CLI. Both
commands talk to PostgreSQL directly, so **only someone with deployment-level
database access can run them**. Every change they make writes an audit event.

## Before you start

- You need the target environment's `DATABASE_URL` (the same least-privilege
  migration/application role used by `pnpm db:migrate`). Staging and production
  URLs come from the operator secret store; never paste them into chat, tickets,
  or shell history files that are shared.
- Run from a trusted operator workstation with Node.js 22+ and `pnpm install`
  completed.
- Migrations must be current: `pnpm db:migrate:status --check`.
- Prefer the interactive prompts. Passwords typed at a prompt are not echoed and
  do not reach shell history; `--password` on the command line does.

Both commands read `DATABASE_URL` from the shell, then `.env`/`.env.local` at the
repo root. An explicit `--database-url` wins.

## First administrator (once per deployment)

```bash
pnpm auth:bootstrap
```

The command asks for the firm name, administrator username, display name, and
password (twice), then creates the firm settings row, the administrator, and a
`firm.bootstrapped` audit event. Only the PBKDF2 password hash is stored.

It refuses to run again once bootstrap completed or any administrator exists.
That refusal is deliberate: use the recovery procedures below instead.

After bootstrap, sign in at the web app. The new administrator must enroll
TOTP MFA before any firm route is reachable and must store the ten recovery
codes offline.

For CI-style provisioning of a disposable environment only:

```bash
pnpm auth:bootstrap --non-interactive --firm-name "Example Firm" --username admin --display-name "Example Admin" --password "<generated test password>"
```

## Choose a recovery action

| Situation | Try first | Offline action |
| --- | --- | --- |
| A staff user forgot their password | Another administrator issues a reset link from **Users → Reset link** | `reset-password` |
| A staff user lost their authenticator | They sign in with a recovery code, then re-enroll under **Security** | `disable-mfa` |
| The only administrator forgot their password | — | `reset-password` |
| The only administrator lost the authenticator **and** recovery codes | — | `disable-mfa` |
| The only administrator was deactivated | — | `reactivate` |

Use the offline command only when no other administrator can fix it in the app.

## Run a recovery action

```bash
pnpm auth:recover
```

The command asks for the account username and one action, then requires you to
type the username again to confirm. It prints one JSON line on success, for
example `{"command":"auth:recover","status":"completed","action":"disable-mfa","username":"admin"}`.
Passwords, hashes, and tokens are never printed.

| Action | Effect |
| --- | --- |
| `reset-password` | Sets a new password hash, invalidates outstanding activation/reset links, revokes every session |
| `disable-mfa` | Deletes the TOTP credential and recovery codes, clears enrollment, revokes every session |
| `reactivate` | Returns a deactivated account to active, revokes every session |

Each action writes a `user.recovery_*` audit event with no actor (the operator
acted outside the application).

Non-interactive form (requires the exact username as confirmation):

```bash
pnpm auth:recover --non-interactive --username admin --action disable-mfa --confirm admin
```

Exit codes: `0` completed, `1` refused by the domain (for example, unknown
account; the JSON line carries a public `code`), `2` usage error, no changes.

## After recovery

1. The user signs in. After `disable-mfa` they are taken straight to MFA
   enrollment and cannot reach firm records until it is confirmed.
2. They store the new recovery codes offline.
3. An administrator reviews **Audit history** for the `user.recovery_*` event
   and records the operator, reason, and time in the operations log.
4. If the lockout was caused by a suspected compromise, also rotate the
   password, review recent `auth.login_failed` events, and deactivate any
   account that should no longer have access.

## Things this runbook never does

- It never creates a second "initial" administrator. Grant the administrator
  role to an existing user from **Users** instead.
- It never edits or deletes audit events. The table rejects updates and deletes.
- It never reads or prints TOTP secrets, recovery codes, or session tokens.

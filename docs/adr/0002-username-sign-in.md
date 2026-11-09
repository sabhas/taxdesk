---
title: "ADR 0002: Sign in with a permanent username instead of an email"
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-09
related:
  - 0001-custom-identity-sessions-and-mfa.md
  - ../product/prd/epic-01-identity-mfa-and-authorization.md
---

# ADR 0002: Sign in with a permanent username instead of an email

Supersedes the sign-in identifier in
[ADR 0001](0001-custom-identity-sessions-and-mfa.md); every other ADR 0001
decision stands.

## Context

ADR 0001 identified staff by email address, but TaxDesk never sends email:
activation and reset links are shared by an administrator, recovery is an
offline CLI, and email delivery is out of scope. The email was only an
identifier, and requiring one adds friction for small-firm staff who may not
have work addresses.

## Decision

- Staff sign in with a **username** and password. There is no email column.
- Usernames are 3–32 characters of lowercase letters, digits, `.`, `_`, or `-`,
  starting and ending with a letter or digit. Input is trimmed and lowercased,
  so sign-in and uniqueness ignore case.
- Usernames are **permanent**: audit history always names the same account. A
  rename, if ever needed, will be a separate audited administrator action.
- The login contract only bounds the username's length so a failed sign-in
  never reveals the username policy; failures stay generic.
- Throttling keys on the hashed normalized username instead of the email.
- Migration `0004_username_sign_in.sql` derives usernames for existing rows from
  the email local part (deduplicated) and drops the email columns.

## Consequences

- An attacker who knows a username can delay that user's sign-in for up to 15
  minutes through the account throttle, as with email before.
- Adding email delivery later needs a forward migration for an optional
  contact address; sign-in remains username-based.

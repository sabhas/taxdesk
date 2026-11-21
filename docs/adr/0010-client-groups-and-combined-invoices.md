---
title: "ADR 0010: Client groups and combined group invoices"
status: proposed
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-11-21
related:
  - ../product/prd/epic-02-client-management.md
  - ../product/prd/epic-05-billing-and-payments.md
  - ../technical/data-model.md
  - ./0004-client-identifier-protection-and-visibility.md
  - ./0007-billing-integrity-and-idempotency.md
---

# ADR 0010: Client groups and combined group invoices

Status is `proposed` until the Product Owner accepts TD-207 and TD-511 in Sprint
Review.

## Context

Staging testers asked to link clients to the client who brought them to the
firm. One example is PGC (Punjab Group of Colleges) with its owner's family and
business partners. Another is Sh. Zaheer & Co. with several family and business
cases. The firm confirmed two things: every group head is itself a client with a
CNIC or NTN, and the main analysis it wants is billing by group. It also wants
to bill a group with one invoice, as well as billing each member separately.

ADR 0004 scopes client visibility per client. ADR 0007 makes finalized invoices
immutable and requires an invoice's case to belong to the invoice's client. A
combined invoice needs a controlled exception to that second rule.

## Decisions

1. **A group is a parent client and its members.** `clients.parent_client_id`
   is a nullable self-reference. There is no separate group record and no group
   name: a group is named after its parent. A separate group entity was
   rejected because every group head is a real client. Free tags were rejected
   because they cannot give reliable totals.
2. **One level, one parent.** A client has at most one parent. A parent cannot
   have a parent, and a client with members cannot be given one. The service
   enforces this under a lock on the parent row. A trigger is the database
   backstop, and a check rejects a client being its own parent. Groups are
   flat, so a member is never counted twice and no cycle detection is needed.
3. **Grouping does not grant access.** Visibility stays per client as in ADR
   0004. A consultant assigned to a parent does not see its members. Member
   lists and group filters show only visible clients and never count hidden
   ones, because a count would disclose that those clients exist. Archiving
   does not cascade, and an archived client keeps its link.
4. **The link is part of the client's versioned update.** Setting or clearing a
   parent is a field of the client's `If-Match` edit and needs `clients.manage`.
   It writes `client.group_changed`, which records client codes only.
5. **Combined invoices are an invoice mode.** `invoices.billing_mode` is
   `individual` (the default, so existing invoices are unchanged) or `combined`.
   A combined invoice is addressed to the parent and has no invoice-level case.
   Each line carries the client it is for (the parent or a member) and an
   optional case. For individual invoices, the ADR 0007 rule that the case must
   belong to the invoice's client is unchanged. For combined invoices, a trigger
   requires each line's case to belong to the line's client, and each line's
   client to be the parent or a member of the parent.
6. **Finalization snapshots the group.** Finalization rechecks group membership
   under the invoice and parent locks, and copies each line's client code and
   display name onto the line. Line items stay frozen as in ADR 0007, so a later
   group change never alters a finalized invoice or its PDF.
7. **The parent pays for the whole invoice.** Payments, reversals, and voids act
   on the whole combined invoice. Splitting amounts across members was rejected
   because it would add payment allocation, which Epic 5 leaves out of scope.
   Group billing totals count a combined invoice against the parent. Member
   amounts appear only as the per-member subtotals on the invoice.
8. **Combined invoice visibility.** A combined invoice is visible only to users
   who can see every client on it.
9. **Duplicate billing warns, does not block.** The draft editor warns when a
   case is already on another invoice that is not void. Partial and follow-up
   billing are legitimate, so this is not a constraint.

## Consequences

- One forward-only migration (`0011`) adds the parent link, the flat-group
  trigger, the billing mode, and the line client, case, and snapshot columns,
  and extends the invoice triggers. If TD-207 ships without TD-511, it splits
  into one migration for groups and one for combined invoices.
- Existing clients have no parent, and existing invoices are `individual`. No
  backfill is needed.
- Relationship types on the link, group filters in Epic 6 reports and the
  dashboard, and a parent column in CSV import are deferred.
- No new secrets are required.

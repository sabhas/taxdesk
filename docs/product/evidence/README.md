---
title: Spike evidence
status: accepted
version: 1.0
owners: [engineering]
last_reviewed: 2026-11-04
---

# Spike evidence

This directory holds machine-generated evidence records that back a sprint review
claim. Files here are produced by a harness, not written by hand.

| File | Produced by | Story |
| --- | --- | --- |
| `td-005-onedrive-spike-report.json` | `pnpm spike:onedrive` (see [`docs/guides/onedrive-spike.md`](../../guides/onedrive-spike.md)) | TD-005 |

## Current records

| Record | Outcome | Recorded |
| --- | --- | --- |
| `td-005-onedrive-spike-report.json` | `passed` — all six required scenarios, blocking decision cleared | 2026-10-31T19:44:43Z |

The TD-005 run that preceded this one failed and was deliberately not committed;
its findings and measurements are captured in
[`docs/product/sprint-1-review-notes.md`](../sprint-1-review-notes.md). A committed
evidence file always represents the current claim for its story.

## Rules

- Evidence files are committed so a reviewer can audit the claim without
  re-running the harness.
- Every record is validated against a strict shared Zod contract before it is
  written. The contract rejects unknown fields and any value that looks like a
  provider token, authorization code, or secret, so an evidence file is safe to
  commit.
- Evidence must never contain real client data, document contents, unmasked
  CNIC/NTN values, or provider tokens. The TD-005 harness uses synthetic,
  non-confidential test files generated from a seed.
- If a record is missing, the corresponding story outcome is `incomplete` and
  must be treated as blocking, never as a pass.

The TD-005 report contract is `OnedriveSpikeReportSchema` in
[`packages/shared/src/onedrive-spike.ts`](../../../packages/shared/src/onedrive-spike.ts).

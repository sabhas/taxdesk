---
title: Definition of Done
status: accepted
version: 1.0
owners: [product, engineering]
last_reviewed: 2026-10-25
---

# Definition of Done

A TaxDesk story is done only when all applicable items are true:

- Every acceptance criterion in its PRD is checked and demonstrated on staging.
- Business rules are enforced by the API, not only by the user interface.
- Request, response, and error contracts have shared Zod validation.
- Authorization and ownership checks have automated coverage.
- Database migrations are forward-only, tested from a clean database, and documented.
- Money uses integer minor units; status and payment history are never silently overwritten.
- Required unit, integration, browser, accessibility, and concurrency tests pass.
- Loading, empty, validation, permission-denied, conflict, and provider-failure states are handled.
- Logs, errors, fixtures, and tests expose no secrets or unmasked confidential tax data.
- The feature is keyboard operable and passes automated accessibility checks without serious violations.
- Observability includes a request ID, structured operational error, and audit event where the action is material.
- Documentation, feature status, and migration/runbook information are updated.
- CI is green and the Product Owner accepts the story in Sprint Review.

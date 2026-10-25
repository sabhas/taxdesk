# TaxDesk — Scalable Tax-Firm Management System Plan

## 1. Product and Architecture Summary

Build a secure, responsive web application for one tax firm per deployment. Each firm receives an independently deployed application, database, secrets, and storage connection.

### Initial production journey

`Client → Tax Case → Checklist/Documents → Review/Filing → Invoice → Payment → Archive`

The first production release includes:

- Custom application login and mandatory MFA.
- User administration and permission-based access.
- Client management and CSV migration.
- Configurable tax services, workflows, deadlines, and checklists.
- Case assignment and status history.
- Pluggable document storage with OneDrive as the first provider.
- Invoices, partial payments, reversals, receipts, and balances.
- Dashboard, operational reports, audit history, backup, and restore procedures.

Deferred until after the first production release:

- Multi-firm onboarding and subscription billing.
- FBR or other government-system integration.
- Email, SMS, and WhatsApp automation.
- OCR, document classification, and full-text search.
- Native mobile or desktop applications.
- Client self-service portal.
- Custom workflow designer and custom role editor.
- Advanced accounting or general-ledger functionality.

### Chosen technology

- Frontend: React, TypeScript, Vite, React Router, TanStack Query, React Hook Form, Zod, Tailwind CSS, and shadcn/ui.
- Backend: TypeScript, Cloudflare Workers with Node.js compatibility, and Hono.
- Database: separate managed PostgreSQL databases for development, staging, and production, with Drizzle ORM and versioned SQL migrations.
- Documents: provider-neutral storage module; Microsoft Graph/OneDrive adapter first.
- Testing: Vitest, a local Worker runtime connected to an isolated managed PostgreSQL test database, Testing Library, Playwright, and adapter contract tests.
- Repository: pnpm workspace modular monolith containing `web`, `api`, and shared packages.
- Deployment: Cloudflare Pages for the React frontend and Cloudflare Workers for the Hono API; Hyperdrive connects to managed PostgreSQL in development, staging, and production; separate local code execution and isolated managed database environments.
- Delivery: trunk-based development, short-lived branches, mandatory CI, and migration checks.

A modular monolith is intentional: modules have explicit boundaries, but the team avoids distributed-system overhead until real scale demands it.

### Scalability model

- Business records do not carry an `organization_id`; a deployment represents one firm.
- Authorization is derived from the authenticated user's roles and permissions; clients never submit or override authorization scope.
- Business identifiers are unique within the deployment.
- Every firm has a separate PostgreSQL database, application configuration, and storage connection.
- The design target is 250 employees, 100,000 clients, and 50 concurrently active users per firm.
- Storage, PDF rendering, notifications, background work, and audit sinks sit behind interfaces.
- Application code depends on domain interfaces rather than OneDrive, Graph, or PostgreSQL-specific objects.
- Production runs the React frontend on Cloudflare Pages and the Hono API on Cloudflare Workers before real confidential data is loaded. Managed PostgreSQL supplies automated backups and point-in-time recovery; encrypted independent exports are retained outside the database provider.

## 2. Interfaces, Data Model, and Engineering Rules

### Authentication and authorization

Use custom application authentication with these fixed rules:

- No public registration.
- An interactive CLI bootstrap creates the firm settings and first administrator.
- Administrators invite users or issue a single-use account-activation link.
- Email addresses are unique after lowercase normalization.
- Passwords require at least 12 characters.
- Password hashes use PBKDF2-HMAC-SHA-256 through Web Crypto with unique salts, versioned parameters, and a documented work factor calibrated during Sprint 2.
- Sessions use random opaque tokens; only a SHA-256 hash of the token is stored.
- The cookie is Secure, HTTP-only, SameSite=Strict, Path `/`, and uses a `__Host-` prefix.
- Sessions have a 30-minute idle timeout and 12-hour absolute lifetime.
- Password, role, deactivation, or MFA changes revoke existing sessions.
- TOTP MFA is mandatory for every production user; single-use recovery codes are stored hashed.
- Account and IP throttling applies to authentication endpoints. Repeated failure requires a valid Turnstile challenge.
- Password reset is initially administrator-issued, single-use, expires after 30 minutes, and forces session revocation.
- An offline CLI recovery procedure exists for the last administrator.
- Same-origin requests plus Origin validation protect state-changing operations from CSRF.

Authorization is permission-based. Initial built-in roles are:

| Role | Primary permissions |
| --- | --- |
| Administrator | Users, integrations, settings, all records, reports, audit |
| Manager | All clients/cases, assignments, review, billing reports |
| Consultant | Assigned clients/cases, checklists, documents |
| Billing | Invoices, payments, receipts, billing reports |
| Read-only | Permitted records without mutations |

Roles are represented in tables and mapped to permissions, but the first release only supports assigning built-in roles. A custom role editor is deferred.

### Core data model

Use UUIDv7 identifiers, UTC timestamps, integer currency minor units, soft deletion where appropriate, and integer `version` columns for optimistic concurrency.

Principal tables:

- Identity: `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `sessions`, `mfa_credentials`, `recovery_codes`, `activation_tokens`.
- Clients: `clients`, `client_contacts`, `client_notes`.
- Workflow: `service_types`, `workflow_templates`, `workflow_statuses`, `workflow_transitions`, `checklist_templates`, `checklist_template_items`.
- Cases: `tax_cases`, `case_assignments`, `case_checklist_items`, `case_status_history`.
- Documents: `storage_connections`, `documents`, `document_events`.
- Billing: `invoices`, `invoice_items`, `payments`, `payment_reversals`, `number_sequences`.
- Operations: `audit_logs`, `idempotency_keys`, `import_batches`, `import_rows`.

Important invariants:

- Tax year, due date, filing date, completion date, invoice date, and payment date remain separate fields.
- Service and workflow templates are versioned. Existing cases retain their original checklist and transition rules when templates change.
- National tax identifiers are encrypted with AES-GCM and a versioned Worker secret. A keyed HMAC blind index supports exact duplicate detection without exposing the identifier.
- Case transitions are validated server-side and create immutable history.
- Draft invoices may be edited. Finalized invoices and payments are immutable.
- An unpaid invoice may be voided. A recorded payment must be reversed through a linked reversal entry rather than deleted.
- All financial mutations are atomic and idempotent.
- Audit events are append-only and exclude passwords, tokens, document contents, and unmasked national identifiers.
- Dates display using the firm timezone, initially `Asia/Karachi`.
- Currency is a firm setting, initially `PKR`.

### API conventions

Expose versioned endpoints beneath `/api/v1`.

Primary resources:

- `/auth/login`, `/auth/logout`, `/auth/mfa`, `/auth/session`, `/auth/password`
- `/users`, `/roles`
- `/clients`, `/clients/{id}`
- `/service-types`, `/workflow-templates`
- `/cases`, `/cases/{id}`, `/cases/{id}/transition`, `/cases/{id}/checklist`
- `/documents`, `/documents/{id}`, `/storage/connections`
- `/invoices`, `/invoices/{id}/finalize`, `/invoices/{id}/void`
- `/invoices/{id}/payments`, `/payments/{id}/reverse`
- `/dashboard`, `/reports`
- `/imports`, `/imports/{id}/validate`, `/imports/{id}/commit`
- `/audit-events`

Conventions:

- Inputs and outputs are validated by shared Zod schemas.
- Errors use Problem Details with `type`, `title`, `status`, `code`, `detail`, field errors, and `requestId`.
- Lists use cursor pagination with a default limit of 25 and maximum of 100.
- Mutable resources return an ETag derived from `version`; updates require `If-Match`.
- Payment, invoice finalization, upload completion, and import commit require `Idempotency-Key`.
- Search and filtering are server-side.
- APIs never expose provider credentials, refresh tokens, password hashes, or encryption material.

### Pluggable document storage

Define one internal contract:

```ts
interface DocumentStorageProvider {
  beginConnection(input: ConnectionRequest): Promise<AuthRedirect>;
  completeConnection(input: ConnectionCallback): Promise<StoredConnection>;
  checkHealth(connection: StoredConnection): Promise<HealthResult>;
  beginUpload(input: UploadRequest): Promise<UploadTarget>;
  completeUpload(input: UploadCompletion): Promise<StoredObject>;
  getDownloadTarget(input: ObjectRequest): Promise<DownloadTarget>;
  getMetadata(input: ObjectRequest): Promise<StoredObject>;
  moveToTrash(input: ObjectRequest): Promise<void>;
}
```

Implementation rules:

- `OneDriveStorageProvider` is the first adapter.
- Tests also use an in-memory fake adapter that satisfies the same contract.
- Provider type and external object IDs are stored in `documents`; no business logic stores OneDrive paths directly.
- A OneDrive Personal account connects through delegated OAuth authorization-code flow.
- Refresh tokens are encrypted with AES-GCM, rotated atomically, and never sent to the browser.
- Revocation or expiry marks the connection unhealthy and presents an administrator reconnect action.
- Uploads use Graph resumable upload sessions and 5 MiB chunks.
- The application limit is configurable and initially 250 MiB.
- Allowed initial file types are PDF, JPEG, PNG, DOCX, XLSX, and CSV.
- Files are organized using stable client/case identifiers, not mutable client names.
- Download and upload-session creation always pass application authorization first.
- Deletion moves the provider object to trash and soft-deletes application metadata.
- A reconciliation job detects missing, moved, or externally deleted provider objects.

Microsoft Graph currently supports delegated personal-account uploads and resumable upload sessions with `Files.ReadWrite`; that is the basis for the OneDrive adapter. See [Microsoft upload documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content) and [Microsoft upload-session documentation](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession).

## 3. Scrum Operating Model

### Cadence and ownership

- Sprint length: two weeks.
- Release target: nine sprints, approximately 18 weeks for one experienced full-time engineer; capacity is recalibrated after Sprint 1.
- Product Owner: firm representative who ranks the backlog and accepts stories.
- Development Team: engineering, testing, deployment, and technical documentation.
- Scrum Master responsibility: facilitator role; it may be held by the engineer initially but remains distinct from Product Owner decisions.

Sprint rhythm:

- Day 1: two-hour planning session and Sprint Goal.
- Daily: 15-minute stand-up focused on goal progress and impediments.
- Mid-sprint: one-hour backlog refinement for the next two sprints.
- Final day: one-hour review against a deployed staging increment.
- Final day: 45-minute retrospective producing at most two concrete process experiments.
- Releases use feature flags so completed work may reach staging without exposing incomplete workflows.

### Definition of Ready

A story enters a sprint only when:

- User, business value, and acceptance criteria are explicit.
- Dependencies and authorization requirements are identified.
- UI/API/data impacts are understood.
- Error and empty states are specified.
- Test data and acceptance owner are available.
- The story is small enough to finish, test, document, and deploy inside one sprint.

### Definition of Done

A story is complete only when:

- Implementation and migration are reviewed.
- Unit, integration, authorization, and applicable end-to-end tests pass.
- Type checking, linting, dependency scanning, and build pass.
- Accessibility and responsive behavior are checked.
- Logs contain no secrets or unmasked sensitive data.
- API and operating documentation are updated.
- The feature is deployed to staging and accepted by the Product Owner.
- Rollback or feature-disable behavior is documented.
- No critical or high-severity known defect remains.

## 4. Executable Sprint Backlog

### Sprint 1 — Walking Skeleton and Platform Validation

**Sprint Goal:** Deploy a tested vertical skeleton and prove that the selected platform and OneDrive Personal integration are feasible.

1. **TD-001 Repository foundation**
   - Create pnpm workspace boundaries for web, API, shared schemas, database, and test utilities.
   - Add strict TypeScript, linting, formatting checks, and import-boundary rules.
   - Acceptance: one command installs, builds, type-checks, and tests the complete workspace.

2. **TD-002 Development environments**
   - Configure separate managed PostgreSQL databases, Hyperdrive bindings, and secret sets for development, staging, and production.
   - Acceptance: local and staging health endpoints identify environment and build version without revealing secrets.

3. **TD-003 Database migration pipeline**
   - Establish ordered Drizzle migrations, migration checksums, local reset, staging apply, and rollback documentation.
   - Acceptance: a clean database reaches the latest version automatically; CI detects an edited historical migration.

4. **TD-004 Web/API walking skeleton**
   - Build the React web shell, health endpoint, request IDs, structured logging, Problem Details errors, and a protected placeholder route.
   - Acceptance: the staging web application loads and successfully calls the Worker API.

5. **TD-005 OneDrive feasibility spike**
   - Register a test Microsoft application, complete delegated consent with the intended Personal account, upload, download, refresh credentials, and simulate revoked consent.
   - Acceptance: a written spike result records scopes, callback settings, token behavior, file limits, failure behavior, and confirms or rejects the planned adapter.

6. **TD-006 CI pipeline**
   - Run install, type check, lint, unit tests, migration validation, build, secret scan, and staging deployment.
   - Acceptance: a failing gate blocks merge and production credentials are inaccessible to pull-request builds.

Deliverable: deployed staging skeleton and validated OneDrive proof of concept.

### Sprint 2 — Authentication, MFA, and Permissions

**Sprint Goal:** Provide secure user access with role- and permission-based authorization.

1. **TD-101 Firm and identity schema**
   - Implement firm settings, users, roles, permissions, sessions, and MFA tables.
   - Seed built-in roles and permission mappings.
   - Acceptance: permission seeds are repeatable and never duplicate data.

2. **TD-102 Administrator bootstrap**
   - Build an interactive CLI command that creates firm settings and the initial administrator without storing a plaintext credential.
   - Acceptance: bootstrap refuses a second initial administrator and writes an audit event.

3. **TD-103 Login and session lifecycle**
   - Implement password hashing, login, logout, idle/absolute expiry, revocation, secure cookie handling, and origin validation.
   - Acceptance: invalid, expired, revoked, and reused sessions cannot access protected endpoints.

4. **TD-104 MFA and recovery**
   - Implement TOTP enrollment, verification, mandatory setup, recovery codes, and last-administrator CLI recovery.
   - Acceptance: production access is blocked until MFA is enrolled; each recovery code works once.

5. **TD-105 User administration**
   - Implement activation links, role assignment, deactivate/reactivate, forced password reset, and session revocation.
   - Acceptance: there is no public registration and a deactivated user loses active access immediately.

6. **TD-106 Authorization framework**
   - Require explicit permissions in route definitions.
   - Acceptance: automated tests prove every protected route rejects missing permissions and inaccessible nested resources.

7. **TD-107 Authentication defenses**
   - Add account/IP throttling, Turnstile escalation, generic login errors, security headers, CSP, and sanitized logs.
   - Acceptance: enumeration is not possible from response text or timing within a documented tolerance.

Deliverable: secure, auditable multi-user staging application.

### Sprint 3 — Client Management

**Sprint Goal:** Replace the client master spreadsheet with searchable, secure client records.

1. **TD-201 Client domain**
   - Implement individual/business client types, client code, legal/display name, encrypted CNIC/NTN, contact details, assigned manager, notes, and active/archive state.
   - Acceptance: required fields depend on client type and validation runs on both client and server.

2. **TD-202 Client CRUD and permissions**
   - Implement create, view, update, archive, and restore.
   - Acceptance: optimistic conflicts show a refresh-and-review prompt instead of silently overwriting changes.

3. **TD-203 Search and filtering**
   - Search by code, normalized name, phone, email, and exact blind-indexed tax identifier.
   - Acceptance: paginated results respect permissions and return within the performance target on synthetic data.

4. **TD-204 Duplicate detection**
   - Warn on matching identifier, email, phone, or high-confidence normalized name.
   - Acceptance: authorized managers may override a warning with a recorded reason; exact identifier duplicates are blocked.

5. **TD-205 Client activity**
   - Display audit-safe history for creation, edits, assignments, archive, and restoration.
   - Acceptance: sensitive before/after values are masked.

Deliverable: accepted client master module.

### Sprint 4 — Configurable Tax-Case Workflow

**Sprint Goal:** Run active tax work through configurable cases and checklists.

1. **TD-301 Service and workflow templates**
   - Implement configurable service types, fees, statuses, allowed transitions, deadline defaults, and checklist templates.
   - Acceptance: publishing creates an immutable template version; later edits do not alter existing cases.

2. **TD-302 Tax cases**
   - Create cases with client, service, tax year, due date, assignees, reviewer, priority, and template snapshot.
   - Acceptance: duplicate active cases for the same client/service/year are warned or blocked according to service configuration.

3. **TD-303 Status transitions**
   - Validate transitions and required checklist conditions server-side.
   - Acceptance: every successful transition records actor, previous/new state, timestamp, and optional note atomically.

4. **TD-304 Case checklist**
   - Complete, reopen, verify, and comment on checklist items with permission separation between preparer and reviewer.
   - Acceptance: a case cannot enter Filed/Completed when required items are incomplete.

5. **TD-305 Assignment and workload views**
   - Add personal queue, team queue, due-soon, overdue, and unassigned filters.
   - Acceptance: counts reconcile with underlying case queries.

6. **TD-306 Concurrency**
   - Require ETags for client, case, assignment, and checklist updates.
   - Acceptance: simultaneous edit tests demonstrate that the second stale update receives HTTP 412 and preserves the first update.

Deliverable: alpha workflow release capable of managing clients and cases without spreadsheets.

### Sprint 5 — Provider-Neutral Documents and OneDrive

**Sprint Goal:** Attach and manage case documents through the storage abstraction.

1. **TD-401 Storage provider contract**
   - Implement the provider interface, registry, provider-neutral domain service, and in-memory test provider.
   - Acceptance: domain and route tests run against the fake provider without importing Graph code.

2. **TD-402 OneDrive connection**
   - Implement administrator connect, callback, encrypted refresh-token storage, token rotation, health display, reconnect, and disconnect safeguards.
   - Acceptance: revoked consent produces an actionable administrator state without exposing credentials.

3. **TD-403 Resumable upload**
   - Validate name, type, and size; initiate an upload session; upload in chunks; finalize against Graph metadata; write document metadata and audit event.
   - Acceptance: interrupted uploads resume; repeated completion is idempotent; unauthorized users cannot obtain upload URLs.

4. **TD-404 Download and open**
   - Generate a short-lived provider target only after client/case permission checks.
   - Acceptance: access is denied after user deactivation or case access removal.

5. **TD-405 Checklist association**
   - Associate documents with client, case, document type, and checklist item; track verification status.
   - Acceptance: verified required documents contribute to checklist completion.

6. **TD-406 Trash and reconciliation**
   - Soft-delete metadata, move files to provider trash, and detect provider-side missing/moved files.
   - Acceptance: reconciliation reports discrepancies without automatically deleting application history.

Deliverable: provider-neutral document module using OneDrive in production configuration.

### Sprint 6 — Billing and Payments

**Sprint Goal:** Produce reliable invoices and track collections without mutable financial history.

1. **TD-501 Invoice drafts**
   - Create invoice drafts from a case or manually with line items, optional discount, due date, and firm currency.
   - Acceptance: totals are calculated server-side using integer minor units.

2. **TD-502 Invoice finalization**
   - Allocate a unique deployment-wide invoice number and freeze billable content atomically.
   - Acceptance: concurrent finalization never creates duplicate numbers; retries return the original result.

3. **TD-503 Invoice documents**
   - Generate branded PDF invoices and save them through the storage provider.
   - Acceptance: the generated total exactly matches the stored invoice and the PDF is linked to its invoice.

4. **TD-504 Payments**
   - Record partial/full payments with date, method, reference, and receipt number.
   - Acceptance: overpayment is rejected unless explicitly enabled later; case state remains independent of payment state.

5. **TD-505 Payment reversal**
   - Reverse a payment with reason and linked correcting entry.
   - Acceptance: the original entry remains unchanged and balances recalculate atomically.

6. **TD-506 Invoice void**
   - Permit voiding only when no active payment remains.
   - Acceptance: paid invoices require payment reversal first and all operations appear in the audit history.

7. **TD-507 Billing permissions**
   - Separate view, draft, finalize, void, payment-record, and payment-reverse permissions.
   - Acceptance: route-level tests cover every permission combination used by built-in roles.

Deliverable: reconciliable billing workflow with invoices, payments, receipts, and balances.

### Sprint 7 — Dashboard, Reports, and Audit Operations

**Sprint Goal:** Give managers and staff a trustworthy operational picture.

1. **TD-601 Role-aware dashboard**
   - Show assigned cases, overdue/due-soon work, checklist gaps, filing progress, unpaid invoices, and monthly collections.
   - Acceptance: dashboard totals reconcile with direct resource queries using the same filters.

2. **TD-602 Operational reports**
   - Provide case status, staff workload, upcoming deadlines, outstanding balances, and collection reports.
   - Acceptance: reports support server-side date/filter parameters and CSV export.

3. **TD-603 Audit explorer**
   - Filter by actor, date, action, entity, and request ID.
   - Acceptance: only administrators may inspect audit logs and sensitive values remain masked.

4. **TD-604 Saved firm settings**
   - Manage firm identity, timezone, currency, numbering prefix, document-size limit, and dashboard deadline windows.
   - Acceptance: settings are validated and changes are audited.

5. **TD-605 Accessibility and responsive pass**
   - Complete keyboard, screen-reader, focus, contrast, and tablet-width review of all primary workflows.
   - Acceptance: critical workflows meet WCAG AA checks and automated accessibility tests have no serious violations.

Deliverable: beta release suitable for real-user workflow evaluation.

### Sprint 8 — CSV Migration, Security, and Recovery

**Sprint Goal:** Prepare trustworthy data and prove the system can be operated and recovered.

1. **TD-701 Import templates**
   - Publish versioned CSV templates for clients, active cases, and opening invoices/balances.
   - Acceptance: each template documents required columns, formats, examples, and identifiers used for relationships.

2. **TD-702 Dry-run validation**
   - Parse without mutation, normalize data, identify duplicates, validate references, and produce downloadable row-level errors.
   - Acceptance: invalid data cannot proceed to commit.

3. **TD-703 Idempotent import commit**
   - Commit a validated batch atomically in bounded chunks and retain source-row lineage.
   - Acceptance: retrying the same batch creates no duplicates and an import reconciliation report is generated.

4. **TD-704 Migration rehearsal**
   - Import a sanitized production-shaped dataset and reconcile record counts, balances, and sampled records.
   - Acceptance: Product Owner signs a migration reconciliation checklist.

5. **TD-705 Backup automation**
   - Verify managed PostgreSQL automated backups and point-in-time recovery, then create a daily encrypted independent export outside the database provider with documented retention.
   - Acceptance: monitoring detects missed provider backup coverage or failed exports; no backup contains application secrets.

6. **TD-706 Restore rehearsal**
   - Restore a backup into an isolated environment and verify authentication, record counts, case states, and balances.
   - Acceptance: measured RTO is at most four hours; documented managed-database point-in-time recovery and a daily independent export provide verified recovery paths.

7. **TD-707 Security review**
   - Review against OWASP ASVS Level 2 principles, dependency findings, authorization matrix, CSP, token handling, logging, and data export behavior.
   - Acceptance: no critical/high finding remains; medium findings have an owner and deadline.

Deliverable: production candidate with rehearsed migration and disaster recovery.

### Sprint 9 — Pilot, Performance, and Production Launch

**Sprint Goal:** Complete a controlled pilot and release a supportable production system.

1. **TD-801 End-to-end pilot**
   - Run representative cases from intake through completion and payment with all three initial users.
   - Acceptance: each role completes its critical workflow without developer intervention.

2. **TD-802 Performance validation**
   - Test with 100,000 clients, representative case/document metadata, 250 users, and 50 concurrent active sessions.
   - Acceptance: excluding Microsoft transfer time, p95 reads remain below 500 ms, writes below 800 ms, and server error rate below 1%.

3. **TD-803 Failure drills**
   - Exercise revoked OneDrive access, expired sessions, stale edits, duplicate payment retries, interrupted uploads, PostgreSQL unavailability, and failed backup notification.
   - Acceptance: each scenario has a safe user response and an operator runbook.

4. **TD-804 Production migration**
   - Freeze source data, run final dry-run, resolve errors, commit, reconcile, and obtain Product Owner sign-off.
   - Acceptance: counts and financial balances match signed source totals.

5. **TD-805 Training and operations**
   - Deliver administrator, staff, billing, recovery, user-offboarding, and OneDrive-reconnect guides.
   - Acceptance: designated administrator performs user creation, restoration test, and provider reconnect using documentation alone.

6. **TD-806 Controlled launch**
   - Enable production for initial users, monitor for one business week, and triage defects daily.
   - Acceptance: no unresolved severity-1/2 defect, backups succeed, and audit/usage metrics are healthy.

Deliverable: production release and prioritized post-launch backlog.

## 5. Verification, Release Gates, and Assumptions

### Required automated tests

- Unit tests for money, invoice state, case transitions, checklist rules, permission evaluation, encryption, password verification, and normalization.
- Schema and migration tests from empty database and previous release database.
- API integration tests against an isolated managed PostgreSQL test database.
- Contract tests executed against both fake storage and OneDrive adapter fixtures.
- Authorization tests for every protected route and every built-in role.
- Authorization tests covering identifier guessing, search, export, and nested-resource access.
- Concurrency tests for client/case updates, invoice numbering, finalization, payment submission, and import commits.
- Browser end-to-end tests for login/MFA, client creation, case workflow, document upload, invoice/payment, CSV import, and user deactivation.
- Failure tests for OAuth revocation, Graph throttling/5xx, upload interruption, stale ETags, duplicate idempotency keys, and unavailable database.
- Accessibility tests plus manual keyboard and screen-reader checks.
- Backup restoration and migration reconciliation tests.

Quality thresholds:

- At least 80% overall automated coverage and 90% for authentication, authorization, financial calculations, and workflow transition modules.
- Zero critical/high dependency or security findings at release.
- No route is considered protected unless its permission requirement is explicit and tested.
- No real client data is used in development or automated tests.

### Release gates

- **Alpha after Sprint 4:** authentication, clients, and cases are usable in staging.
- **Beta after Sprint 7:** documents and billing complete the operating workflow.
- **Release candidate after Sprint 8:** migration, security, backup, and recovery are proven.
- **Production after Sprint 9:** pilot acceptance, reconciliation, training, and monitoring are complete.

### Explicit assumptions and defaults

- The first deployment serves one Pakistani tax firm.
- Each firm is deployed independently; multi-firm tenancy and self-service onboarding are out of scope.
- Initial language is English; localization-ready message keys are used from the beginning.
- Initial timezone is Asia/Karachi and currency is PKR, both firm-configurable.
- OneDrive Personal is the initial file provider and is connected by an administrator-owned account.
- Users authenticate only to TaxDesk; they do not share the Microsoft account.
- Production documents stay in OneDrive; PostgreSQL stores metadata only.
- OneDrive feasibility must pass Sprint 1. If it fails, the storage contract remains unchanged and an R2 adapter replaces OneDrive work in Sprint 5.
- The first production deployment uses Cloudflare Pages for the React application and Cloudflare Workers for the Hono API. Hyperdrive provides pooled TLS connections to managed PostgreSQL using a least-privilege credential.
- Development, staging, and production use separate managed PostgreSQL databases with automated backup and point-in-time-recovery capability. Encrypted independent exports are retained outside the database provider. Restore is rehearsed before production migration and at least quarterly thereafter.
- Deployment automation provisions one dedicated database and storage connection per firm.
- Email/SMS notification delivery is excluded; deadlines appear in the application dashboard.
- CSV migration includes clients, active cases, and opening invoice balances—not complete historical accounting.
- The Product Owner supplies service types, workflow statuses, checklist items, branding, invoice wording, and sanitized migration samples before their respective sprint begins.

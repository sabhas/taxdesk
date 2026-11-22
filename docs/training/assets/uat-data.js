/* TaxDesk UAT scenario catalogue.
   Each case: [title, role, kind, preconditions, steps[], expected].
   role: admin | manager | consultant | billing | readonly | operator | any
   kind: pos (happy path) | neg (must be refused or handled safely)
   Case IDs are generated as UAT-<story>-<nn> in list order, so append new cases at the
   end of a story to keep existing IDs (and saved results) stable. */
window.TAXDESK_UAT = [
  {
    epic: '0',
    title: 'Foundation and platform',
    stories: [
      {
        id: 'TD-001',
        title: 'Workspace and quality baseline',
        cases: [
          ['Full quality gate passes on a clean checkout', 'operator', 'pos', 'Fresh clone, Node 22+, pnpm 10', ['Run pnpm install --frozen-lockfile', 'Run pnpm verify'], 'Every gate passes: typecheck, lint, format, tests, migrate verify, secrets, workflows, config posture, self-test, build'],
        ],
      },
      {
        id: 'TD-002',
        title: 'Isolated environments',
        cases: [
          ['Health endpoint reports only safe fields', 'operator', 'pos', 'Staging deployed', ['curl https://<staging-host>/health'], 'Exactly environment, releaseVersion, requestId; environment is "staging"; Cache-Control: no-store'],
          ['Health endpoint leaks nothing', 'operator', 'neg', 'Staging deployed', ['Inspect the /health body and headers for database names, hosts, or secrets'], 'No connection details, database names, hosts, or secrets appear'],
        ],
      },
      {
        id: 'TD-003',
        title: 'Migration discipline',
        cases: [
          ['Clean database migrates fully', 'operator', 'pos', 'Empty database', ['pnpm db:migrate', 'pnpm db:migrate:status --check'], 'Migrations 0001–0010 applied; status check exits 0'],
          ['Edited migration is rejected', 'operator', 'neg', 'Local branch', ['Change one character in an applied migration file', 'Run pnpm db:migrate:verify', 'Revert the change'], 'Verification fails with a checksum mismatch'],
        ],
      },
      {
        id: 'TD-004',
        title: 'API and web walking skeleton',
        cases: [
          ['Errors carry a request ID', 'operator', 'pos', 'Any environment', ['Call GET /api/v1/clients without signing in'], '401 Problem Details JSON with code and requestId; X-Request-Id header matches'],
          ['Friendly message when the API is down', 'any', 'neg', 'Local; stop pnpm dev:api', ['Reload the web app'], '"TaxDesk is temporarily unavailable" with a Try again button; no raw error'],
        ],
      },
      {
        id: 'TD-005',
        title: 'OneDrive feasibility spike',
        cases: [
          ['Spike evidence is recorded', 'operator', 'pos', '—', ['Open docs/product/evidence/td-005-onedrive-spike-report.json'], 'Consent, refresh, upload, download, interrupted upload, and revoked consent all passed (2026-10-31)'],
        ],
      },
      {
        id: 'TD-006',
        title: 'CI and staging deployment',
        cases: [
          ['A merge to main deploys staging', 'operator', 'pos', 'Branch protection on', ['Merge a passing PR', 'Watch CI then deploy-staging.yml', 'Check /health releaseVersion'], 'Staging reports the merged commit SHA; smoke check green'],
          ['A failing check blocks delivery', 'operator', 'neg', 'Test PR', ['Open a PR with a deliberate lint error'], 'Quality gates fails, merge is blocked, nothing deploys'],
          ['PR builds cannot read secrets', 'operator', 'neg', '—', ['Run pnpm ci:workflows', 'Review a PR run log'], 'Policy passes; PR jobs use no environment and no secrets'],
        ],
      },
      {
        id: 'TD-007',
        title: 'Web UI foundation',
        cases: [
          ['Deep links survive sign-in', 'consultant', 'pos', 'Signed out', ['Open /cases/<id> directly', 'Sign in and complete MFA'], 'The case page opens, not the dashboard'],
          ['Back and forward work', 'any', 'pos', 'Signed in', ['Open Clients, a client, then a case', 'Use browser Back twice and Forward once'], 'Each step shows the matching page'],
          ['Works on a phone', 'any', 'pos', 'Phone width (375px)', ['Open the app', 'Use Open navigation to reach Cases'], 'No sideways scrolling; menu opens and closes; text readable'],
          ['Revoking access needs confirmation', 'admin', 'neg', 'A test user exists', ['Users → Deactivate', 'Cancel the dialog'], 'Nothing changes until the confirmation button is pressed'],
        ],
      },
    ],
  },
  {
    epic: '1',
    title: 'Identity, MFA, and authorization',
    stories: [
      {
        id: 'TD-101',
        title: 'Firm and identity schema',
        cases: [
          ['Five built-in roles exist', 'admin', 'pos', 'Bootstrapped firm', ['Users → Invite a user → open the Role list'], 'Administrator, Manager, Consultant, Billing, Read-only; no others'],
        ],
      },
      {
        id: 'TD-102',
        title: 'Initial administrator bootstrap',
        cases: [
          ['Bootstrap creates the first administrator', 'operator', 'pos', 'Migrated, empty database', ['pnpm auth:bootstrap and answer the prompts', 'Sign in'], 'Forced to MFA enrolment; audit history shows firm.bootstrapped'],
          ['Bootstrap cannot run twice', 'operator', 'neg', 'Already bootstrapped', ['Run pnpm auth:bootstrap again'], 'Refused; no second administrator created'],
        ],
      },
      {
        id: 'TD-103',
        title: 'Password and session protection',
        cases: [
          ['Idle session expires', 'any', 'neg', 'Signed in', ['Leave the app idle for 31 minutes', 'Click any link'], '"Your session expired. Sign in again to continue."'],
          ['Session cookie is protected', 'operator', 'pos', 'Signed in, browser dev tools', ['Inspect cookies'], 'Session cookie name starts with __Host-, is Secure, HttpOnly, SameSite=Strict'],
          ['Short password refused', 'consultant', 'neg', 'Fresh activation link', ['Enter an 11-character password'], 'Refused: at least 12 characters'],
        ],
      },
      {
        id: 'TD-104',
        title: 'Sign in and out',
        cases: [
          ['Sign in with username, password, and MFA', 'consultant', 'pos', 'Active account with MFA', ['Enter username and password', 'Enter the authenticator code'], 'Dashboard shows "Welcome, <name>"'],
          ['Wrong password gives a generic message', 'consultant', 'neg', '—', ['Enter a valid username and a wrong password'], 'Generic failure that does not say whether the username or the password was wrong'],
          ['Email address is not a username', 'consultant', 'neg', '—', ['Try to sign in with an email address'], 'Sign-in fails generically'],
          ['Sign out ends the session', 'consultant', 'pos', 'Signed in', ['Select Sign out', 'Press browser Back'], 'Sign-in page; no firm data shown'],
        ],
      },
      {
        id: 'TD-105',
        title: 'Current-user context',
        cases: [
          ['Menu matches the role', 'billing', 'pos', 'Sign in as each role in turn', ['Compare the side menu with the Roles page table'], 'Each role sees exactly its items (for example Billing: no Services, Users, Data import)'],
          ['Hidden page still protected', 'readonly', 'neg', 'Signed in as read-only', ['Type /users into the address bar'], 'No user list is shown; the API refuses the data'],
        ],
      },
      {
        id: 'TD-106',
        title: 'Authorization middleware',
        cases: [
          ['Guessing a case ID reveals nothing', 'consultant', 'neg', 'Know the ID of a case not assigned to you', ['Open /cases/<that id>'], 'Access denied, the same as for an ID that does not exist; no case details'],
          ['Changes without a session are refused', 'operator', 'neg', '—', ['POST /api/v1/clients with no cookie'], '401 Problem Details'],
        ],
      },
      {
        id: 'TD-107',
        title: 'TOTP MFA and recovery codes',
        cases: [
          ['Enrol MFA on first sign-in', 'consultant', 'pos', 'Just activated', ['Scan the QR code', 'Enter the code → Enable MFA', 'I have saved these codes'], '10 recovery codes shown once; app opens'],
          ['MFA cannot be skipped', 'consultant', 'neg', 'Activated, not enrolled', ['After password, try to open /clients'], 'Enrolment screen is forced; no firm data'],
          ['Recovery code works once', 'consultant', 'neg', 'Enrolled; a saved code', ['Sign in using the recovery code', 'Sign out; sign in with the same code'], 'First succeeds; second is refused'],
          ['Regenerate recovery codes', 'consultant', 'pos', 'Signed in', ['Security → password + code → Regenerate codes'], 'New codes shown; old codes stop working; other sessions signed out'],
          ['Disable and re-enrol MFA', 'consultant', 'pos', 'Signed in', ['Security → password + code → tick the box → Disable MFA'], 'Forced back to MFA enrolment'],
          ['Expired MFA challenge', 'consultant', 'neg', '—', ['Enter the password, wait over 5 minutes, then enter a code'], 'Challenge refused; Start over required'],
        ],
      },
      {
        id: 'TD-108',
        title: 'Administrator user lifecycle',
        cases: [
          ['Invite shows a one-time link', 'admin', 'pos', '—', ['Users → Invite a user → Send invitation'], 'One-time link card with expiry; status Invited; no email sent'],
          ['Activation link works only once', 'consultant', 'neg', 'A used activation link', ['Open the link again'], 'Refused; must ask for a new link'],
          ['Activation link expires after 30 minutes', 'consultant', 'neg', 'Link older than 30 minutes', ['Open the link and submit a password'], 'Refused as expired'],
          ['Role change takes effect and signs the user out', 'admin', 'pos', 't.readonly signed in elsewhere', ['Change t.readonly to Billing'], 'Their other session ends; next sign-in shows the Billing menu'],
          ['Deactivation ends sessions immediately', 'admin', 'neg', 't.billing signed in elsewhere', ['Deactivate t.billing', 'In their window, click any link'], 'Their session is gone and sign-in fails; their audit history remains'],
          ['Reset link lets a user set a new password', 'admin', 'pos', '—', ['Reset link on a user', 'User opens it and sets a password'], 'Old password stops working; new one works'],
        ],
      },
      {
        id: 'TD-109',
        title: 'Permission enforcement',
        cases: [
          ['Consultant only updates assigned cases', 'consultant', 'neg', 'A case assigned to someone else', ['Try to move its status (via a direct link or the API)'], 'Refused with 403'],
          ['Read-only cannot change anything', 'readonly', 'neg', '—', ['Open a client, case, and invoice'], 'No Edit, Archive, status, Record payment, or Upload buttons; direct API calls return 403'],
        ],
      },
      {
        id: 'TD-110',
        title: 'Authentication defences',
        cases: [
          ['Turnstile after repeated failures', 'any', 'neg', 'Turnstile keys configured', ['Fail sign-in 5 times for one account'], 'A Turnstile check appears before more attempts'],
          ['Sign-in paused after too many failures', 'any', 'neg', '—', ['Keep failing (10 for one account)'], '"Too many sign-in attempts. Wait a few minutes and try again."'],
          ['Security headers present', 'operator', 'pos', 'Staging', ['curl -I https://<staging-host>/'], 'Content-Security-Policy and the other headers from public/_headers are present'],
        ],
      },
      {
        id: 'TD-111',
        title: 'Account recovery',
        cases: [
          ['Offline MFA reset for a locked-out admin', 'operator', 'pos', 'Admin has no phone and no codes', ['pnpm auth:recover → username → disable-mfa → retype username', 'Admin signs in'], 'JSON line status completed; admin forced to re-enrol; user.recovery_* audit event with no actor'],
          ['Recovery requires confirmation', 'operator', 'neg', '—', ['Run auth:recover and type a different username at the confirmation'], 'No change is made'],
        ],
      },
    ],
  },
  {
    epic: '2',
    title: 'Client management',
    stories: [
      {
        id: 'TD-201',
        title: 'Client schema and validation',
        cases: [
          ['Individual needs a CNIC', 'manager', 'neg', '—', ['New client → Individual → leave CNIC empty → create'], 'Field error on CNIC; nothing saved'],
          ['Business needs an NTN', 'manager', 'neg', '—', ['New client → Business → leave NTN empty → create'], 'Field error on NTN'],
          ['Only one primary contact', 'manager', 'neg', '—', ['Add two contacts and mark both primary'], 'Refused; exactly one primary required'],
        ],
      },
      {
        id: 'TD-202',
        title: 'Create and view clients',
        cases: [
          ['Create an individual client', 'manager', 'pos', '—', ['New client with CNIC, a contact, and a manager', 'Check and create client'], 'Client page opens with a CL-xxxxx code and a masked CNIC'],
          ['Consultant sees only managed clients', 'consultant', 'neg', 't.consultant manages 5 clients', ['Open Clients'], 'Exactly those 5 clients; note "You see the clients assigned to you as manager."'],
          ['Billing cannot create clients', 'billing', 'neg', '—', ['Open Clients'], 'No New client button; /clients/new is refused'],
        ],
      },
      {
        id: 'TD-203',
        title: 'Update and concurrent edits',
        cases: [
          ['Edit conflict is detected', 'manager', 'neg', 'Two windows (manager and admin) editing the same client', ['Admin saves a change', 'Manager saves a different change'], '"Someone else saved this client" with both versions; nothing overwritten'],
          ['Resolve by saving over the latest', 'manager', 'pos', 'Conflict screen showing', ['Save my changes over the latest'], 'Saved; activity shows both edits'],
        ],
      },
      {
        id: 'TD-204',
        title: 'Search, filter, and pagination',
        cases: [
          ['Name search ignores punctuation and suffixes', 'any', 'pos', 'Client "Khan Traders (Pvt.) Ltd."', ['Search "khan traders"'], 'The client is found'],
          ['Exact CNIC search', 'manager', 'pos', 'Known synthetic CNIC', ['Search the full 13-digit CNIC'], 'Exactly that client; identifier still masked'],
          ['No-results state', 'any', 'pos', '—', ['Search "zzzz-none"'], 'A clear no-results message'],
          ['Load more pages', 'any', 'pos', 'More than one page of clients', ['Load more clients'], 'Next page appended; no duplicates'],
        ],
      },
      {
        id: 'TD-205',
        title: 'Duplicate detection',
        cases: [
          ['Same CNIC is blocked, even when archived', 'manager', 'neg', 'An archived client with CNIC X', ['Create a new client with CNIC X'], '"This client already exists" with a link; cannot continue'],
          ['Similar name warns; override needs a reason', 'manager', 'pos', 'Client "Basil Stone" exists', ['Create another "Basil Stone" with a different CNIC', 'Enter a reason → Create anyway'], 'Created; the reason appears in activity'],
        ],
      },
      {
        id: 'TD-206',
        title: 'Archive and activity history',
        cases: [
          ['Archive and restore', 'manager', 'pos', 'Active client', ['Archive → confirm', 'Filter Status = Archived', 'Restore → confirm'], 'Hidden by default when archived; editable again after restore'],
          ['Archived client is read-only', 'manager', 'neg', 'Archived client', ['Open it'], 'No Edit; changes refused'],
          ['Activity masks sensitive values', 'admin', 'pos', 'Client whose NTN was changed', ['Open its Activity'], 'Shows that the NTN changed, never the value'],
        ],
      },
      {
        id: 'TD-207',
        title: 'Client groups',
        cases: [
          ['Link a member to a group head', 'manager', 'pos', 'Business client A and individual client B', ['Edit B → Parent client = A → Save changes'], 'B shows "Part of A"; A shows B under Group members; Clients list Group column shows "Group head · 1 member" on A'],
          ['Create a client inside a group', 'manager', 'pos', 'Group head A', ['New client → Parent client = A → Check and create client'], 'New client page shows "Part of A"'],
          ['Groups are one level deep', 'manager', 'neg', 'A heads a group with member B; client C', ['Edit C → Parent client: B is not offered', 'Edit A → Parent client is switched off'], 'B cannot be a parent; A cannot be given a parent; nothing saved'],
          ['Archive keeps the link', 'manager', 'pos', 'A heads a group with member B', ['Archive A', 'Open B', 'Edit C → look for A under Parent client'], 'B still shows "Part of A" (Archived); A is not offered as a new parent'],
          ['Group filters', 'manager', 'pos', 'A heads a group with member B; each has a case and a finalized invoice', ['Clients → Group = A', 'Cases → Group = A', 'Invoices → Group = A'], 'Each list shows only A and B records; queue counts follow the filter'],
          ['Group billing totals', 'billing', 'pos', 'A and B have finalized invoices, one part-paid, and a draft', ['Invoices → Group = A'], 'Invoiced, Paid, and Outstanding match the finalized invoices; the draft is not counted'],
          ['Consultant sees only visible members', 'consultant', 'neg', 't.consultant manages A and B but not member D', ['Open A', 'Clients → Group = A', 'Move a managed client from A to a group the consultant cannot see; open its Activity'], 'Group members lists only B; D is not named or counted; the move to the hidden group is not shown in Activity'],
          ['Only managers set a parent', 'billing', 'neg', '—', ['Try to edit a client'], 'No Edit or New client; direct PATCH with parentClientId returns 403'],
          ['Group change is audited by code', 'admin', 'pos', 'B moved from group A to group E', ['Audit → action client.group_changed'], 'Event shows B, A, and E client codes only; B activity shows "Changed the parent client"'],
        ],
      },
    ],
  },
  {
    epic: '3',
    title: 'Tax-case workflow',
    stories: [
      {
        id: 'TD-301',
        title: 'Service types',
        cases: [
          ['Create a service', 'manager', 'pos', 'A published workflow', ['Services → New service with fee, deadline, policy, workflow'], 'Listed and selectable for new cases'],
          ['Fee change does not touch open cases', 'manager', 'pos', 'An open case for the service', ['Change the service fee', 'Open the existing case'], 'The case keeps its original fee'],
          ['Consultant cannot manage services', 'consultant', 'neg', '—', ['Open /services'], 'Not in the menu; refused'],
        ],
      },
      {
        id: 'TD-302',
        title: 'Workflow template versions',
        cases: [
          ['Publish a version', 'manager', 'pos', 'New template', ['Save draft → Publish version 1'], '"Version 1 published. New cases can use it now."'],
          ['Invalid workflow cannot be published', 'manager', 'neg', 'Draft', ['Add a status nothing can reach (or make two initial statuses)'], 'Problem flagged; Publish disabled'],
          ['Published version is frozen', 'manager', 'neg', 'Published version', ['Try to edit it'], 'Not editable; Start new draft required'],
        ],
      },
      {
        id: 'TD-303',
        title: 'Checklist templates',
        cases: [
          ['New version does not change old cases', 'manager', 'pos', 'Case on version 1', ['Publish version 2 with an extra checklist item', 'Open the old case'], 'Old case still shows the version 1 checklist'],
        ],
      },
      {
        id: 'TD-304',
        title: 'Create a tax case',
        cases: [
          ['Open a case from a client', 'consultant', 'pos', 'Client managed by t.consultant', ['Client page → Open case → fill in → Open case'], 'TC-xxxxx code; initial status; due date pre-filled'],
          ['Duplicate warning needs a reason', 'manager', 'neg', 'Open case for the same client, service (Warn), and year', ['Open another'], '"Possible duplicate case"; needs a reason; Open case anyway'],
          ['Duplicate blocked by policy', 'manager', 'neg', 'Service with Block policy and an open case', ['Open another for the same client and year'], 'Refused'],
          ['Consultant cannot assign someone else', 'consultant', 'neg', '—', ['New case; try a different primary consultant'], 'Only themselves allowed'],
          ['Reviewer must differ from consultant', 'manager', 'neg', '—', ['Pick the same person for both'], 'Refused'],
        ],
      },
      {
        id: 'TD-305',
        title: 'Case details and draft editing',
        cases: [
          ['Edit details', 'manager', 'pos', 'Open case', ['Edit details → change due date → Save changes'], 'Saved; shown in Activity'],
          ['Stale edit refused', 'manager', 'neg', 'Two windows on the same case', ['Save in window A, then save in window B'], 'Window B explains the conflict and reloads the latest version'],
        ],
      },
      {
        id: 'TD-306',
        title: 'Server-validated status transitions',
        cases: [
          ['Allowed move succeeds', 'consultant', 'pos', 'Case in Intake', ['Select Collecting documents'], 'Status changes; history row with actor and time'],
          ['Disallowed move is not offered', 'consultant', 'neg', 'Case in Intake', ['Look for Filed'], 'No Filed button'],
          ['Checklist gate shows the reason', 'consultant', 'neg', 'In review with required items incomplete', ['Look at the Filed button'], 'Disabled with the reason shown underneath'],
        ],
      },
      {
        id: 'TD-307',
        title: 'Checklist completion and review',
        cases: [
          ['Preparer completes, reviewer verifies', 'consultant', 'pos', 'Item needs review', ['t.consultant: Complete', 't.reviewer: Verify'], 'Verified by t.reviewer; counts update'],
          ['No verifying your own work', 'manager', 'neg', 'Manager completed an item', ['Same manager: Verify'], 'Refused'],
          ['Return needs a comment', 'consultant', 'neg', 'Completed item; signed in as reviewer', ['Return with an empty comment'], 'Refused until a comment is entered'],
          ['Checklist locks after filing', 'consultant', 'neg', 'Filed case', ['Try to reopen an item'], 'Refused: the checklist is locked'],
        ],
      },
      {
        id: 'TD-308',
        title: 'Assignment and workload queues',
        cases: [
          ['Queue counts match lists', 'manager', 'pos', 'Training data', ['Compare each queue count with its rows'], 'Counts equal row totals'],
          ['Overdue uses the firm calendar', 'manager', 'pos', 'Case due yesterday (Asia/Karachi)', ['Open Overdue'], 'The case is listed'],
          ['Unassigned queue', 'manager', 'pos', 'Case with no consultant', ['Open Unassigned; assign a consultant'], 'It leaves Unassigned and appears in their My work'],
        ],
      },
      {
        id: 'TD-309',
        title: 'Case history and safe archive',
        cases: [
          ['Archive a completed case', 'manager', 'pos', 'Completed case', ['Archive → Archive case'], 'Listed under Archived; read-only; history kept'],
          ['Open cases cannot be archived', 'manager', 'neg', 'Case In preparation', ['Look for Archive'], 'Not allowed'],
        ],
      },
      {
        id: 'TD-310',
        title: 'Concurrency',
        cases: [
          ['Two people move the status at once', 'manager', 'neg', 'Same case in two windows', ['Move the status in both, one after the other, without reloading'], 'Second is refused with a conflict; only one move in history'],
        ],
      },
    ],
  },
  {
    epic: '4',
    title: 'Document storage',
    stories: [
      {
        id: 'TD-401',
        title: 'Storage provider port',
        cases: [
          ['Boundary test passes', 'operator', 'pos', '—', ['pnpm --filter @taxdesk/api test -- src/storage/boundary.test.ts'], 'Passes; business code never imports the OneDrive adapter'],
        ],
      },
      {
        id: 'TD-402',
        title: 'Connection data and token encryption',
        cases: [
          ['Tokens never reach the browser', 'admin', 'neg', 'Storage connected; dev tools open', ['Open Document storage; inspect network responses'], 'No access or refresh token in any response'],
        ],
      },
      {
        id: 'TD-403',
        title: 'OneDrive administrator connection',
        cases: [
          ['Connect storage', 'admin', 'pos', 'ONEDRIVE_CLIENT_ID set', ['Document storage → Connect storage → consent'], 'Status Connected with who and when'],
          ['Only administrators connect', 'manager', 'neg', '—', ['Open the storage settings path'], 'Not in the menu; refused'],
          ['Disconnect asks for confirmation', 'admin', 'pos', 'Connected', ['Disconnect → confirm'], 'Not connected; audited'],
        ],
      },
      {
        id: 'TD-404',
        title: 'Token refresh and health',
        cases: [
          ['Revoked consent stops document actions', 'admin', 'neg', 'Connected', ['Revoke the TaxDesk app in the Microsoft account', 'Check now; try an upload'], 'Reconnect required; upload stops with a clear message; admins see Reconnect storage'],
          ['Reconnect restores access', 'admin', 'pos', 'Reconnect required', ['Reconnect storage with the same account'], 'Connected; earlier documents open again'],
        ],
      },
      {
        id: 'TD-405',
        title: 'Stable storage layout',
        cases: [
          ['Unsupported type refused before upload', 'consultant', 'neg', '—', ['Upload a .exe or .zip'], 'Refused before any bytes are sent'],
          ['Renaming a client keeps documents', 'manager', 'pos', 'Client with documents', ['Change the legal name', 'Open a document'], 'It still opens'],
        ],
      },
      {
        id: 'TD-406',
        title: 'Resumable upload',
        cases: [
          ['Large file uploads in pieces', 'consultant', 'pos', 'File over 10 MiB', ['Upload document'], 'Progress bar advances; document appears Awaiting review'],
          ['Pause and resume', 'consultant', 'pos', 'Large upload running', ['Pause, wait, Resume'], 'Completes; one document'],
          ['Interrupted connection resumes', 'consultant', 'neg', 'Large upload running', ['Turn off the network briefly, then on', 'Retry'], 'Continues from where it stopped; one document only'],
          ['Over the size limit', 'consultant', 'neg', 'Firm limit set to 1 MiB', ['Upload a 2 MiB file'], 'Refused with the limit shown'],
        ],
      },
      {
        id: 'TD-407',
        title: 'Protected document access',
        cases: [
          ['Open a document', 'readonly', 'pos', 'Case with a document', ['Open'], 'File downloads; open recorded in Activity'],
          ['Billing cannot open documents', 'billing', 'neg', '—', ['Open a case page'], 'No Documents panel and no access'],
          ['Access re-checked after reassignment', 'consultant', 'neg', 'Consultant removed from the case', ['Open the old document link'], 'Refused'],
        ],
      },
      {
        id: 'TD-408',
        title: 'Metadata and checklist links',
        cases: [
          ['Verified document unlocks the item', 'consultant', 'pos', 'Required item needing a CNIC copy', ['Reviewer verifies the linked document', 'Preparer completes the item'], 'Completed'],
          ['Item needs a verified document', 'consultant', 'neg', 'Linked document still Awaiting review', ['Complete'], '"Link and verify a CNIC copy document before completing this item."'],
          ['Rejecting the document reopens the item', 'consultant', 'neg', 'Completed item backed by one document', ['Reviewer rejects the document with a reason'], 'Item reopens automatically; change logged'],
          ['Preparer cannot verify documents', 'consultant', 'neg', 'Own case, not reviewer', ['Look for Verify on a document'], 'Not available; refused by the API'],
        ],
      },
      {
        id: 'TD-409',
        title: 'Soft delete and restore',
        cases: [
          ['Delete hides the document', 'consultant', 'pos', 'Document on an assigned case', ['Delete → Delete document'], 'Hidden; visible with Show deleted documents'],
          ['Manager restores', 'manager', 'pos', 'Deleted document still in the OneDrive recycle bin', ['Show deleted documents → Restore'], 'Back to normal'],
          ['Consultant cannot restore', 'consultant', 'neg', 'Deleted document', ['Look for Restore'], 'Not available'],
        ],
      },
      {
        id: 'TD-410',
        title: 'Provider reconciliation',
        cases: [
          ['Reconciliation flags missing files', 'admin', 'neg', 'Delete one TaxDesk file directly in OneDrive (staging only)', ['Run reconciliation'], 'Missing count 1; document shows Missing in storage; nothing deleted'],
        ],
      },
      {
        id: 'TD-411',
        title: 'Browsable OneDrive folder layout',
        cases: [
          ['Case file lands in a readable folder', 'consultant', 'pos', 'Case TC-xxxxx for client CL-xxxxx; app folder shared view-only with the tester', ['Upload a document on the case', 'Open the shared folder in OneDrive'], 'File is at clients → client code → tax year → case code, with no ID folders'],
          ['Client-level file goes to general', 'manager', 'pos', 'Client with no case', ['Upload a document on the client page', 'Look in OneDrive'], 'File is at clients → client code → general'],
          ['Same name twice keeps both', 'consultant', 'pos', 'Case already has bank-statement.pdf', ['Upload another bank-statement.pdf to the same case', 'Open both in TaxDesk'], 'Both upload; OneDrive shows bank-statement 1.pdf; TaxDesk shows bank-statement.pdf for both and each opens its own file'],
          ['Invoice PDF sits with its case', 'billing', 'pos', 'Invoice drafted from a case', ['Finalize the invoice', 'Look in OneDrive'], 'INV number PDF is in the case folder; a combined group invoice is in the group head\'s general folder'],
          ['Share cannot change files', 'readonly', 'neg', 'App folder shared view-only', ['Try to rename or delete a file in OneDrive'], 'OneDrive refuses; TaxDesk records are unchanged'],
        ],
      },
    ],
  },
  {
    epic: '5',
    title: 'Billing and payments',
    stories: [
      {
        id: 'TD-501',
        title: 'Invoice money rules',
        cases: [
          ['Negative total refused', 'billing', 'neg', 'Draft with 1,000 of lines', ['Discount 5,000 → Save draft'], 'Refused'],
          ['Server recomputes totals', 'billing', 'pos', 'Draft', ['Two lines and a discount → Save draft'], 'Saved totals equal lines minus discount'],
        ],
      },
      {
        id: 'TD-502',
        title: 'Draft creation and editing',
        cases: [
          ['Draft from a case', 'billing', 'pos', 'Case for "Income tax return"', ['Create invoice'], 'First line is the service name and fee'],
          ['Draft from a client', 'billing', 'pos', '—', ['Client page → Create invoice'], 'Empty draft'],
          ['Manager cannot draft', 'manager', 'neg', '—', ['Open a case'], 'No Create invoice'],
          ['Invoice never changes the case status', 'billing', 'pos', 'Case In preparation', ['Create, finalize, and pay an invoice'], 'Case still In preparation'],
        ],
      },
      {
        id: 'TD-503',
        title: 'Finalize an invoice',
        cases: [
          ['Finalize assigns the next number', 'billing', 'pos', 'Saved draft', ['Finalize… → Finalize invoice'], 'INV-xxxxx with no gap; lines frozen'],
          ['Double finalize gives one number', 'billing', 'neg', 'Saved draft', ['Double-click Finalize invoice (or retry after a timeout)'], 'One number used; the next invoice gets the next number'],
          ['Finalized invoice cannot be edited', 'billing', 'neg', 'Finalized invoice', ['Look for Save draft'], 'Not editable'],
        ],
      },
      {
        id: 'TD-504',
        title: 'Invoice PDF',
        cases: [
          ['PDF matches the invoice', 'billing', 'pos', 'Finalized invoice', ['Download PDF'], 'Number, client, total, and currency match the screen'],
          ['Storage down: invoice still saved', 'billing', 'neg', 'Storage disconnected', ['Finalize', 'Reconnect storage', 'Generate PDF again'], '"PDF could not be stored" first; PDF available after retry'],
          ['Invoice PDFs stay out of document lists', 'manager', 'pos', 'Finalized invoice on a case', ['Open the case Documents panel'], 'The invoice PDF is not listed'],
        ],
      },
      {
        id: 'TD-505',
        title: 'Invoice list and detail',
        cases: [
          ['Filter by payment state', 'readonly', 'pos', 'Mixed invoices', ['Invoices → Payment filter = Unpaid'], 'Only unpaid invoices'],
          ['Consultant has no invoices', 'consultant', 'neg', '—', ['Type /invoices'], 'Not in the menu; refused'],
        ],
      },
      {
        id: 'TD-506',
        title: 'Record payments',
        cases: [
          ['Partial then full payment', 'billing', 'pos', 'Finalized 28,000 invoice', ['Record 10,000 Cash', 'Record 18,000 Bank transfer'], 'Partly paid, then Paid; outstanding 0'],
          ['Overpayment refused', 'billing', 'neg', 'Outstanding 18,000', ['Record 20,000'], 'Refused'],
          ['Zero or negative refused', 'billing', 'neg', '—', ['Record 0'], 'Refused'],
          ['Duplicate submit records once', 'billing', 'neg', '—', ['Double-click save in Record a payment'], 'One payment and one receipt'],
          ['Concurrent overpayment', 'billing', 'neg', 'Two Billing windows, outstanding 10,000', ['Record 8,000 in both at the same moment'], 'Only one succeeds'],
        ],
      },
      {
        id: 'TD-507',
        title: 'Payment receipts',
        cases: [
          ['Receipt per payment', 'billing', 'pos', 'A payment recorded', ['Receipt on the payment row'], 'RCP-xxxxx PDF with the payment and invoice; invoice PDF unchanged'],
        ],
      },
      {
        id: 'TD-508',
        title: 'Reverse a payment',
        cases: [
          ['Manager reverses with a reason', 'manager', 'pos', 'Paid invoice', ['Reverse → amount and reason'], 'Linked reversal; original payment still listed; balance back'],
          ['Billing cannot reverse', 'billing', 'neg', '—', ['Look for Reverse'], 'Not available; API returns 403'],
          ['Cannot reverse more than paid', 'manager', 'neg', 'Payment 10,000', ['Reverse 12,000'], 'Refused'],
        ],
      },
      {
        id: 'TD-509',
        title: 'Void an unpaid invoice',
        cases: [
          ['Void an unpaid invoice', 'billing', 'pos', 'Finalized, no payments', ['Void invoice → reason → confirm'], 'Status Void; number and history kept'],
          ['Void blocked with net payments', 'billing', 'neg', 'Partly paid invoice', ['Void invoice'], 'Refused until payments are reversed'],
        ],
      },
      {
        id: 'TD-510',
        title: 'Financial integrity',
        cases: [
          ['Case → invoice → partial → settled', 'billing', 'pos', 'Filed case', ['Follow end-to-end walkthrough steps 7–8'], 'Every figure reconciles; audit shows billing.* events'],
        ],
      },
      {
        id: 'TD-511',
        title: 'Combined group invoices',
        cases: [
          ['Create a combined invoice', 'billing', 'pos', 'Group head A with members B and C; B has a case', ['Open A → Create combined invoice'], 'Draft addressed to A, no case, no lines; page says "A combined invoice to A"'],
          ['Only offered on a group head', 'billing', 'neg', 'Member B; client D with no members', ['Open B', 'Open D'], 'No Create combined invoice on either page'],
          ['Bill a member case at the service fee', 'billing', 'pos', 'Combined draft for A', ['Add line → Billed for = B → Case = B\'s case', 'Add line for A and one for C → Save draft'], 'Case line filled with service, tax year, and fee; preview shows a subtotal for A, B, and C; total is the sum'],
          ['Duplicate billing warns only', 'billing', 'pos', 'B\'s case already on a finalized invoice', ['Choose that case on a combined line → Save draft'], 'Warning names the other invoice; the draft still saves'],
          ['Finalize rechecks the group', 'billing', 'neg', 'Saved combined draft with a line for C', ['Manager removes C from the group', 'Finalize'], 'Refused: "… is no longer in this group"; dialog closes and C\'s Billed for field is marked; still a draft with no number'],
          ['Finalized invoice is frozen', 'billing', 'pos', 'Finalized combined invoice', ['Rename B and move it out of the group', 'Reopen the invoice and download the PDF'], 'Lines still show B\'s old name; PDF groups lines under A, B, C with subtotals, names only, no CNIC/NTN'],
          ['Pay and reverse as a whole', 'billing', 'pos', 'Finalized combined invoice', ['Record a partial payment', 'Manager reverses it', 'Void the invoice'], 'Balance, receipt, reversal, and void behave as for any invoice'],
          ['Counted against the group head', 'billing', 'pos', 'Finalized combined invoice', ['Invoices → Group = A', 'Open B → Invoices'], 'Group totals include it; B\'s own invoice list does not'],
          ['Hidden from users who cannot see every client', 'consultant', 'neg', 'Combined invoice for A', ['Open the invoice link'], 'Access refused'],
        ],
      },
    ],
  },
  {
    epic: '6',
    title: 'Dashboard and operations',
    stories: [
      {
        id: 'TD-601',
        title: 'Role-aware dashboard',
        cases: [
          ['Consultant sees own work only', 'consultant', 'pos', 'Training data', ['Open Dashboard'], 'Cases that need attention only; no Team workload or Billing'],
          ['Figures link to matching rows', 'manager', 'pos', '—', ['Click the Overdue number'], 'The list shows exactly that many cases'],
          ['Billing figures', 'billing', 'pos', 'Paid and unpaid invoices', ['Open Dashboard'], 'Unpaid, Overdue, and Collected this month match Reports'],
        ],
      },
      {
        id: 'TD-602',
        title: 'Case and workload reports',
        cases: [
          ['Filter and export', 'manager', 'pos', '—', ['Reports → Cases → tax year 2026 → Export CSV'], 'CSV matches the screen; export appears in audit'],
          ['Consultant has no reports', 'consultant', 'neg', '—', ['Type /reports'], 'Refused'],
        ],
      },
      {
        id: 'TD-603',
        title: 'Billing reports',
        cases: [
          ['Totals match invoices', 'billing', 'pos', 'This month\'s invoices', ['Reports → Billing → this month'], 'Invoiced, received, reversed, net, outstanding, and overdue agree with invoice pages'],
          ['Zero-result range', 'billing', 'pos', '—', ['Pick a range with no activity'], 'Clear empty state, zero totals'],
        ],
      },
      {
        id: 'TD-604',
        title: 'Audit explorer',
        cases: [
          ['Wildcard action search', 'admin', 'pos', 'Billing activity exists', ['Audit history → Action billing.* → Search'], 'Only billing events'],
          ['Find by request ID', 'admin', 'pos', 'A request ID from an error message', ['Search Request ID'], 'The matching event(s)'],
          ['Non-admins denied', 'manager', 'neg', '—', ['Type /audit'], 'Refused'],
          ['Identifiers masked', 'admin', 'pos', 'Client events', ['Open a client.created event'], 'No full CNIC/NTN anywhere'],
        ],
      },
      {
        id: 'TD-605',
        title: 'Firm settings and accessibility',
        cases: [
          ['Change the invoice prefix', 'admin', 'pos', '—', ['Prefix INV → TAX → Save settings', 'Finalize a new invoice'], 'New invoice uses TAX-; older ones keep INV-; audited with old and new values'],
          ['Invalid prefix refused', 'admin', 'neg', '—', ['Prefix "inv1"'], 'Refused: 2–6 capital letters'],
          ['Non-admin view only', 'manager', 'neg', '—', ['Open Firm settings'], '"Your role can view but not change firm settings."'],
          ['Keyboard-only use', 'any', 'pos', 'No mouse', ['Tab through Dashboard and Reports; use filters and links'], 'Visible focus everywhere; everything reachable'],
        ],
      },
    ],
  },
  {
    epic: '7',
    title: 'Migration, security, and recovery',
    stories: [
      {
        id: 'TD-701',
        title: 'Versioned CSV templates',
        cases: [
          ['Download templates', 'admin', 'pos', '—', ['Data import → Templates'], 'clients, cases, opening balances; synthetic examples only'],
        ],
      },
      {
        id: 'TD-702',
        title: 'Import batch and dry run',
        cases: [
          ['Dry run writes nothing', 'admin', 'pos', 'Sample clients file', ['Run dry run', 'Check the Clients count'], 'Plan shows creates; client count unchanged'],
          ['Errors block commit', 'admin', 'neg', 'File made with --with-exceptions', ['Run dry run'], 'Errors listed by row and column; Commit unavailable'],
          ['Wrong header rejects the file', 'admin', 'neg', 'Rename one column', ['Run dry run'], 'IMPORT_FILE_INVALID; nothing stored'],
        ],
      },
      {
        id: 'TD-703',
        title: 'Retry-safe import commit',
        cases: [
          ['Commit and reconcile', 'admin', 'pos', 'Clean dry run', ['Choose the same file → Commit import'], 'Committed; Reconciled; counts match source-totals.json'],
          ['Interrupted commit resumes', 'admin', 'neg', 'Large file', ['Commit; drop the network mid-way', 'Choose the same file → Resume commit'], 'Finishes; no row written twice'],
          ['Different file refused at commit', 'admin', 'neg', 'Clean dry run', ['Choose another file → Commit'], 'IMPORT_SOURCE_MISMATCH'],
        ],
      },
      {
        id: 'TD-704',
        title: 'Import review and correction',
        cases: [
          ['Duplicate decision needs a reason', 'admin', 'neg', 'Possible duplicate row', ['Decide → Create a new client anyway → reason "ok"'], 'Refused: at least 10 characters'],
          ['Exports never contain cell values', 'admin', 'pos', 'Batch with exceptions', ['Download Exceptions CSV'], 'Row numbers, refs, and fixed messages only; import.exceptions_exported in audit'],
        ],
      },
      {
        id: 'TD-705',
        title: 'Import security',
        cases: [
          ['Non-admins cannot import', 'manager', 'neg', '—', ['Type /imports'], 'Refused (403)'],
          ['Oversized file refused', 'admin', 'neg', 'CSV over 2 MiB or 5,000 rows', ['Run dry run'], 'Refused; nothing stored'],
        ],
      },
      {
        id: 'TD-706',
        title: 'Migration rehearsal',
        cases: [
          ['Rehearsal reconciles and is signed', 'admin', 'pos', 'Staging; 800-client sample', ['Follow docs/guides/migration-rehearsal.md'], 'All 10 checks match; Product Owner and engineering lead sign'],
        ],
      },
      {
        id: 'TD-707',
        title: 'Backup automation and monitoring',
        cases: [
          ['Daily export succeeds', 'operator', 'pos', 'Backup secrets and bucket configured', ['Run backup-export.yml'], 'Encrypted dump and manifest in R2; ci:backup-verify green'],
          ['Failure raises an alert', 'operator', 'neg', 'Test run with a wrong bucket', ['Run the workflow'], 'Issue "Independent backup export failed" opened'],
        ],
      },
      {
        id: 'TD-708',
        title: 'Restore rehearsal',
        cases: [
          ['Restore within four hours', 'operator', 'pos', 'Isolated target database', ['Follow the restore procedure', 'ops:restore-verify'], 'Evidence ok, elapsed under 4 hours, functional checks pass'],
        ],
      },
      {
        id: 'TD-709',
        title: 'Security review',
        cases: [
          ['No open critical or high findings', 'operator', 'pos', '—', ['Review docs/product/security-review-2026-11.md', 'Run gitleaks and dependency audit'], 'Zero open critical/high; signed'],
        ],
      },
      {
        id: 'TD-710',
        title: 'Production readiness review',
        cases: [
          ['Go/no-go recorded', 'admin', 'pos', 'All above done', ['Complete docs/product/production-readiness-review.md'], 'Decision, release SHA, rollback owner, and trigger recorded'],
        ],
      },
    ],
  },
];

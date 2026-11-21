import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlExecutor, type SqlExecutor } from '@taxdesk/database';
import {
  DirectoryMigrationSource,
  createPostgresExecutor,
  runMigrations,
} from '@taxdesk/database/migrations';
import { STARTER_WORKFLOW_DEFINITION, newUuidV7 } from '@taxdesk/shared';
import { bytesToBase64Url } from '../crypto/encoding.js';
import { createPasswordHasher } from '../crypto/password.js';
import { createSecretCipher } from '../crypto/cipher.js';
import { buildDependencies, type AppDependencies } from '../dependencies.js';
import { BootstrapService } from '../domain/auth/bootstrap-service.js';
import type { Actor } from '../domain/auth/types.js';
import { CombinedInvoiceRuleError, type Repositories } from './ports.js';

/**
 * Epic 5 repositories and migration 0008 against PostgreSQL. The suite runs in
 * its own schema (`search_path`), so it never races the public-schema suite in
 * `postgres.integration.test.ts` when both run in one Vitest invocation.
 */

const baseConnectionString =
  process.env['TAXDESK_API_TEST_DATABASE_URL'] ??
  process.env['TAXDESK_MIGRATIONS_TEST_DATABASE_URL'];

const SCHEMA = 'taxdesk_billing_it';

function assertDisposable(url: string): void {
  const name = new URL(url).pathname.replace(/^\//u, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run against "${name}": the database name must end with "_test".`);
  }
}

function withSchema(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('search_path', SCHEMA);
  return parsed.toString();
}

const describeWithDatabase = baseConnectionString === undefined ? describe.skip : describe;
const migrationsDirectory = fileURLToPath(
  new URL('../../../database/migrations/', import.meta.url),
);

describeWithDatabase('billing repositories and triggers against PostgreSQL', () => {
  let executor: SqlExecutor;
  let dependencies: AppDependencies;
  let repositories: Repositories;
  let clockNow: Date;
  let owner: Actor;
  let clientA: string;
  let caseA: string;
  let serviceId: string;
  let workflowVersionId: string;

  const tick = (): string => {
    clockNow = new Date(clockNow.getTime() + 1_000);
    return clockNow.toISOString();
  };

  beforeAll(async () => {
    assertDisposable(baseConnectionString!);
    const connectionString = withSchema(baseConnectionString!);
    const admin = createPostgresExecutor(baseConnectionString!);
    await admin.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.execute(`CREATE SCHEMA ${SCHEMA}`);
    await admin.close();
    const migrations = createPostgresExecutor(connectionString);
    await runMigrations({
      executor: migrations,
      source: new DirectoryMigrationSource(migrationsDirectory),
    });
    await migrations.close();

    clockNow = new Date('2026-03-01T00:00:00.000Z');
    executor = createSqlExecutor(connectionString, {
      requireTls: !/[?&]sslmode=disable/u.test(connectionString),
      maxConnections: 4,
    });
    const key = bytesToBase64Url(new Uint8Array(32).fill(5));
    dependencies = buildDependencies({
      executor,
      authConfig: {
        mfaEncryptionKey: key,
        turnstileSecretKey: undefined,
        turnstileSiteKey: undefined,
        allowedOrigins: [],
        appPublicUrl: 'https://taxdesk.test',
        clientDataEncryptionKey: bytesToBase64Url(new Uint8Array(32).fill(21)),
        clientIdentifierIndexKey: bytesToBase64Url(new Uint8Array(32).fill(23)),
      },
      clock: () => new Date(clockNow),
      passwordHasher: createPasswordHasher({
        version: 1,
        iterations: 1_000,
        saltBytes: 16,
        hashBytes: 32,
      }),
      cipher: createSecretCipher(key),
    });
    repositories = dependencies.repositories;

    const bootstrap = new BootstrapService({
      repositories,
      unitOfWork: dependencies.unitOfWork,
      passwordHasher: dependencies.passwordHasher,
      tokenHasher: dependencies.tokenHasher,
      clock: dependencies.clock,
    });
    const result = await bootstrap.bootstrap({
      firmName: 'Billing Firm',
      username: 'owner',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const user = await repositories.users.findById(result.userId);
    const session = await dependencies.sessionService.issue(user!, {
      mfaVerified: true,
      requestId: 'bill-db-session',
    });
    owner = (await dependencies.sessionService.validate(session.token))!;

    tick();
    const template = await dependencies.workflowTemplateService.create({
      actor: owner,
      requestId: 'bill-db-template',
      request: {
        name: 'Billing workflow',
        description: '',
        definition: STARTER_WORKFLOW_DEFINITION,
      },
    });
    tick();
    const version = await dependencies.workflowTemplateService.publish({
      actor: owner,
      templateId: template.id,
      versionId: template.draft!.id,
      expectedVersion: 1,
      requestId: 'bill-db-publish',
    });
    tick();
    const service = await dependencies.serviceTypeService.create({
      actor: owner,
      requestId: 'bill-db-service',
      request: {
        name: 'Billing service',
        description: '',
        defaultFeeMinor: 1_000_000,
        defaultDeadlineOffsetDays: 30,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: template.id,
      },
    });
    serviceId = service.id;
    workflowVersionId = version.id;
    tick();
    clientA = (
      await dependencies.clientService.createClient({
        actor: owner,
        requestId: 'bill-db-client',
        request: {
          type: 'business',
          legalName: 'Billing Client A',
          ntn: '1234567',
          contacts: [],
          assignedManagerUserId: owner.userId,
        },
      })
    ).id;
    tick();
    caseA = (
      await dependencies.caseService.createCase({
        actor: owner,
        requestId: 'bill-db-case',
        request: {
          clientId: clientA,
          serviceTypeId: service.id,
          taxYear: 2025,
          workflowVersionId: version.id,
          dueDate: '2026-09-30',
          primaryConsultantUserId: owner.userId,
          reviewerUserId: null,
          notes: '',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await executor.close();
  });

  let requests = 0;
  const rid = (): string => `bill-db-${String(++requests)}`;
  const idem = (): string => `idem-key-${String(++requests).padStart(12, '0')}`;
  const billing = () => dependencies.billingService;

  async function draft(total = 1_000_000, clientId = clientA) {
    tick();
    const created = await billing().createDraft({
      actor: owner,
      request: { clientId },
      requestId: rid(),
    });
    tick();
    return await billing().updateDraft({
      actor: owner,
      id: created.id,
      expectedVersion: created.version,
      requestId: rid(),
      request: {
        items: [{ description: 'Return', quantity: 1, unitAmountMinor: total }],
        discountMinor: 0,
        issueDate: null,
        dueDate: null,
        notes: '',
      },
    });
  }

  async function finalized(total = 1_000_000, clientId = clientA) {
    const prepared = await draft(total, clientId);
    tick();
    const result = await billing().finalizeInvoice({
      actor: owner,
      id: prepared.id,
      expectedVersion: prepared.version,
      idempotencyKey: idem(),
      requestId: rid(),
    });
    return result.value;
  }

  const pay = (invoiceId: string, amountMinor: number, key = idem()) =>
    billing().recordPayment({
      actor: owner,
      invoiceId,
      idempotencyKey: key,
      requestId: rid(),
      request: { amountMinor, method: 'cash', receivedOn: '2026-03-01', reference: '' },
    });

  const sql = async (text: string, params: unknown[] = []) => await executor.query(text, params);

  it('drafts from a case with the service fee', async () => {
    tick();
    const invoice = await billing().createDraft({
      actor: owner,
      request: { caseId: caseA },
      requestId: rid(),
    });
    expect(invoice).toMatchObject({ totalMinor: 1_000_000, case: { id: caseA }, status: 'draft' });
    const stored = await billing().getInvoice(owner, invoice.id);
    expect(stored.items).toHaveLength(1);
  });

  it('allocates unique gapless numbers across concurrent finalizations', async () => {
    const drafts = await Promise.all([draft(), draft(), draft(), draft()]);
    const results = await Promise.allSettled(
      drafts.map((entry) =>
        billing().finalizeInvoice({
          actor: owner,
          id: entry.id,
          expectedVersion: entry.version,
          idempotencyKey: idem(),
          requestId: rid(),
        }),
      ),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const numbers = results.map((result) =>
      result.status === 'fulfilled' ? Number(result.value.value.invoiceNumber?.slice(4)) : 0,
    );
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(4);
    expect(sorted[3]! - sorted[0]!).toBe(3);
  });

  it('finalizes once when the same invoice is finalized concurrently with one key', async () => {
    const prepared = await draft();
    const key = idem();
    const before = await sql('SELECT next_value FROM number_sequences WHERE key = $1', ['invoice']);
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        billing().finalizeInvoice({
          actor: owner,
          id: prepared.id,
          expectedVersion: prepared.version,
          idempotencyKey: key,
          requestId: rid(),
        }),
      ),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const numbers = new Set(
      results.map((result) =>
        result.status === 'fulfilled' ? result.value.value.invoiceNumber : '',
      ),
    );
    expect(numbers.size).toBe(1);
    const after = await sql('SELECT next_value FROM number_sequences WHERE key = $1', ['invoice']);
    expect(Number(after[0]!['next_value']) - Number(before[0]!['next_value'])).toBe(1);
    const audit = await sql(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'billing.invoice_finalized' AND entity_id = $1",
      [prepared.id],
    );
    expect(audit[0]!['n']).toBe(1);
  });

  it('rolls a failed finalization back without burning a number', async () => {
    const empty = await billing().createDraft({
      actor: owner,
      request: { clientId: clientA },
      requestId: rid(),
    });
    const before = await sql('SELECT next_value FROM number_sequences WHERE key = $1', ['invoice']);
    await expect(
      billing().finalizeInvoice({
        actor: owner,
        id: empty.id,
        expectedVersion: empty.version,
        idempotencyKey: idem(),
        requestId: rid(),
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_EMPTY' });
    const after = await sql('SELECT next_value FROM number_sequences WHERE key = $1', ['invoice']);
    expect(after[0]!['next_value']).toEqual(before[0]!['next_value']);
  });

  it('answers a duplicate payment with the same key from one row', async () => {
    const invoice = await finalized();
    const key = idem();
    const results = await Promise.allSettled([
      pay(invoice.id, 300_000, key),
      pay(invoice.id, 300_000, key),
      pay(invoice.id, 300_000, key),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const ids = new Set(
      results.map((result) => (result.status === 'fulfilled' ? result.value.value.payment.id : '')),
    );
    expect(ids.size).toBe(1);
    const rows = await sql('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [
      invoice.id,
    ]);
    expect(rows[0]!['n']).toBe(1);
    await expect(pay(invoice.id, 100, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('never lets concurrent payments exceed the outstanding balance', async () => {
    const invoice = await finalized(1_000_000);
    const results = await Promise.allSettled([
      pay(invoice.id, 600_000),
      pay(invoice.id, 600_000),
      pay(invoice.id, 600_000),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({
        code: 'PAYMENT_EXCEEDS_OUTSTANDING',
      });
    }
    const current = await billing().getInvoice(owner, invoice.id);
    expect(current).toMatchObject({ paidMinor: 600_000, outstandingMinor: 400_000 });
    const receipts = await sql('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [
      invoice.id,
    ]);
    expect(receipts[0]!['n']).toBe(1);
  });

  it('settles partially then fully, and reversals restore the balance', async () => {
    const invoice = await finalized(1_000_000);
    const first = await pay(invoice.id, 250_000);
    expect(first.value.invoice).toMatchObject({ paymentStatus: 'partially_paid' });
    const second = await pay(invoice.id, 750_000);
    expect(second.value.invoice).toMatchObject({ paymentStatus: 'paid', outstandingMinor: 0 });
    tick();
    const reversed = await billing().reversePayment({
      actor: owner,
      paymentId: second.value.payment.id,
      idempotencyKey: idem(),
      requestId: rid(),
      request: { amountMinor: 750_000, reason: 'Bounced cheque' },
    });
    expect(reversed.value.invoice).toMatchObject({
      paidMinor: 250_000,
      paymentStatus: 'partially_paid',
    });
    await expect(
      billing().reversePayment({
        actor: owner,
        paymentId: second.value.payment.id,
        idempotencyKey: idem(),
        requestId: rid(),
        request: { amountMinor: 1, reason: 'Again' },
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_EXCEEDS_PAYMENT' });
  });

  it('allows only one of two concurrent over-reversals', async () => {
    const invoice = await finalized(1_000_000);
    const paid = await pay(invoice.id, 1_000_000);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        billing().reversePayment({
          actor: owner,
          paymentId: paid.value.payment.id,
          idempotencyKey: idem(),
          requestId: rid(),
          request: { amountMinor: 700_000, reason: 'Race' },
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const current = await billing().getInvoice(owner, invoice.id);
    expect(current.paidMinor).toBe(300_000);
  });

  it('refuses a void with active payments and a stale version', async () => {
    const invoice = await finalized(1_000_000);
    const paid = await pay(invoice.id, 100_000);
    await expect(
      billing().voidInvoice({
        actor: owner,
        id: invoice.id,
        expectedVersion: paid.value.invoice.version,
        idempotencyKey: idem(),
        requestId: rid(),
        request: { reason: 'Mistake', confirm: true },
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_HAS_ACTIVE_PAYMENTS' });
    await expect(
      billing().voidInvoice({
        actor: owner,
        id: invoice.id,
        expectedVersion: 1,
        idempotencyKey: idem(),
        requestId: rid(),
        request: { reason: 'Mistake', confirm: true },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects a stale draft edit', async () => {
    const prepared = await draft();
    await expect(
      billing().updateDraft({
        actor: owner,
        id: prepared.id,
        expectedVersion: 1,
        requestId: rid(),
        request: { items: [], discountMinor: 0, issueDate: null, dueDate: null, notes: '' },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('lists with filters and cursor paging', async () => {
    const first = await billing().listInvoices(owner, { clientId: clientA, limit: 2 });
    expect(first.invoices).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await billing().listInvoices(owner, {
      clientId: clientA,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.invoices[0]!.id).not.toBe(first.invoices[0]!.id);
    const paid = await billing().listInvoices(owner, { paymentStatus: 'paid', limit: 50 });
    expect(paid.invoices.every((entry) => entry.paymentStatus === 'paid')).toBe(true);
  });

  describe('client groups (TD-207)', () => {
    let groupSequence = 0;

    async function groupClient(
      parentClientId: string | null,
      assignedManagerUserId: string | null = null,
    ) {
      groupSequence += 1;
      tick();
      return await dependencies.clientService.createClient({
        actor: owner,
        requestId: rid(),
        request: {
          type: 'business',
          legalName: `Group Business ${String(groupSequence)}`,
          ntn: String(7_100_000 + groupSequence),
          contacts: [],
          assignedManagerUserId,
          parentClientId,
        },
      });
    }

    async function caseFor(clientId: string) {
      tick();
      return await dependencies.caseService.createCase({
        actor: owner,
        requestId: rid(),
        request: {
          clientId,
          serviceTypeId: serviceId,
          taxYear: 2024,
          workflowVersionId,
          dueDate: '2026-09-30',
          primaryConsultantUserId: owner.userId,
          reviewerUserId: null,
          notes: '',
        },
      });
    }

    it('filters cases, queue counts, and invoices by group in SQL and totals the group', async () => {
      const head = await groupClient(null);
      const member = await groupClient(head.id);
      const outsider = await groupClient(null);
      const headCase = await caseFor(head.id);
      const memberCase = await caseFor(member.id);
      await caseFor(outsider.id);

      const cases = await dependencies.caseService.listCases(owner, {
        view: 'team',
        limit: 25,
        group: head.id,
      });
      expect(cases.total).toBe(2);
      expect(cases.cases.map((entry) => entry.id).sort()).toEqual(
        [headCase.id, memberCase.id].sort(),
      );
      const counts = await dependencies.caseService.queueCounts(owner, { group: head.id });
      expect(counts.team).toBe(2);

      const headInvoice = await finalized(1_000_000, head.id);
      const memberInvoice = await finalized(500_000, member.id);
      await finalized(900_000, outsider.id);
      const memberDraft = await draft(300_000, member.id);
      tick();
      await pay(memberInvoice.id, 200_000);

      const listed = await billing().listInvoices(owner, { group: head.id, limit: 50 });
      expect(listed.invoices.map((entry) => entry.id).sort()).toEqual(
        [headInvoice.id, memberInvoice.id, memberDraft.id].sort(),
      );

      const totals = await billing().groupBillingTotals(owner, { group: head.id });
      expect(totals).toEqual({
        groupClientId: head.id,
        currency: 'PKR',
        invoiceCount: 2,
        invoicedMinor: 1_500_000,
        paidMinor: 200_000,
        outstandingMinor: 1_300_000,
      });
      // The SQL totals agree with the invoice rows they summarize.
      const reference = await sql(
        `SELECT count(*)::int AS n, sum(total_minor)::bigint AS invoiced,
                sum(paid_minor)::bigint AS paid, sum(outstanding_minor)::bigint AS outstanding
         FROM invoices WHERE status = 'finalized' AND client_id = ANY ($1::uuid[])`,
        [[head.id, member.id]],
      );
      expect(Number(reference[0]?.['n'])).toBe(totals.invoiceCount);
      expect(Number(reference[0]?.['invoiced'])).toBe(totals.invoicedMinor);
      expect(Number(reference[0]?.['paid'])).toBe(totals.paidMinor);
      expect(Number(reference[0]?.['outstanding'])).toBe(totals.outstandingMinor);
    });

    it('lists group heads by visible members only for a restricted user', async () => {
      // Both heads are visible to the owner; only one has a member the owner manages.
      const visibleHead = await groupClient(null, owner.userId);
      await groupClient(visibleHead.id, owner.userId);
      const hiddenHead = await groupClient(null, owner.userId);
      await groupClient(hiddenHead.id, null);

      const heads = async (restrictToManagerUserId: string | null) =>
        (
          await repositories.clients.list({
            search: null,
            type: null,
            manager: null,
            state: 'all',
            restrictToManagerUserId,
            groupClientId: null,
            grouping: 'heads',
            limit: 100,
            after: null,
          })
        ).clients.map((client) => client.id);

      expect(await heads(null)).toEqual(expect.arrayContaining([visibleHead.id, hiddenHead.id]));
      const restricted = await heads(owner.userId);
      expect(restricted).toContain(visibleHead.id);
      expect(restricted).not.toContain(hiddenHead.id);
    });
  });

  describe('combined group invoices (TD-511)', () => {
    let sequence = 0;

    async function client(parentClientId: string | null) {
      sequence += 1;
      tick();
      return await dependencies.clientService.createClient({
        actor: owner,
        requestId: rid(),
        request: {
          type: 'business',
          legalName: `Combined Business ${String(sequence)}`,
          ntn: String(7_300_000 + sequence),
          contacts: [],
          assignedManagerUserId: null,
          parentClientId,
        },
      });
    }

    async function caseFor(clientId: string) {
      tick();
      return await dependencies.caseService.createCase({
        actor: owner,
        requestId: rid(),
        request: {
          clientId,
          serviceTypeId: serviceId,
          taxYear: 2023,
          workflowVersionId,
          dueDate: '2026-09-30',
          primaryConsultantUserId: owner.userId,
          reviewerUserId: null,
          notes: '',
        },
      });
    }

    /** A head with one member (with a case) and a saved combined draft billing both. */
    async function combinedDraft() {
      const head = await client(null);
      const member = await client(head.id);
      const memberCase = await caseFor(member.id);
      tick();
      const created = await billing().createDraft({
        actor: owner,
        request: { clientId: head.id, billingMode: 'combined' },
        requestId: rid(),
      });
      tick();
      const saved = await billing().updateDraft({
        actor: owner,
        id: created.id,
        expectedVersion: created.version,
        requestId: rid(),
        request: {
          items: [
            {
              description: 'Head advisory',
              quantity: 1,
              unitAmountMinor: 200_000,
              clientId: head.id,
            },
            {
              description: 'Member return',
              quantity: 1,
              unitAmountMinor: 1_000_000,
              clientId: member.id,
              caseId: memberCase.id,
            },
          ],
          discountMinor: 0,
          issueDate: null,
          dueDate: null,
          notes: '',
        },
      });
      return { head, member, memberCase, draft: saved };
    }

    async function leaveGroup(member: { id: string }, transaction: SqlExecutor = executor) {
      await transaction.query(
        'UPDATE clients SET parent_client_id = NULL, version = version + 1 WHERE id = $1',
        [member.id],
      );
    }

    const finalizeDraft = (draftInvoice: { id: string; version: number }) =>
      billing().finalizeInvoice({
        actor: owner,
        id: draftInvoice.id,
        expectedVersion: draftInvoice.version,
        idempotencyKey: idem(),
        requestId: rid(),
      });

    it('finalizes with a client snapshot that a later group change never alters', async () => {
      const { head, member, memberCase, draft: prepared } = await combinedDraft();
      tick();
      const result = await finalizeDraft(prepared);
      expect(result.value.status).toBe('finalized');
      expect(result.value.billingMode).toBe('combined');
      await leaveGroup(member);
      await sql("UPDATE clients SET display_name = 'Renamed Later' WHERE id = $1", [member.id]);
      const reloaded = await billing().getInvoice(owner, prepared.id);
      expect(reloaded.items.map((item) => item.client?.displayName)).toEqual([
        head.displayName,
        member.displayName,
      ]);
      expect(reloaded.items[1]?.case?.id).toBe(memberCase.id);
      const rows = await sql(
        'SELECT client_code_snapshot, client_name_snapshot FROM invoice_items WHERE invoice_id = $1 ORDER BY position',
        [prepared.id],
      );
      expect(rows.map((row) => row['client_code_snapshot'])).toEqual([
        head.clientCode,
        member.clientCode,
      ]);

      // Group totals count it against the head; the list case filter finds it by its line.
      const totals = await billing().groupBillingTotals(owner, { group: head.id });
      expect(totals).toMatchObject({ invoiceCount: 1, invoicedMinor: 1_200_000 });
      const byCase = await billing().listInvoices(owner, { caseId: memberCase.id, limit: 25 });
      expect(byCase.invoices.map((invoice) => invoice.id)).toEqual([prepared.id]);
    });

    it('refuses finalization when a group change commits while it waits for the client lock', async () => {
      const { member, draft: prepared } = await combinedDraft();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const groupChange = executor.transaction(async (transaction) => {
        await leaveGroup(member, transaction);
        locked();
        await gate;
      });
      await holding;
      tick();
      const finalizing = finalizeDraft(prepared);
      // Give finalization time to reach the member's row lock, then commit the change.
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await groupChange;
      await expect(finalizing).rejects.toMatchObject({ code: 'INVOICE_GROUP_CHANGED' });
      const current = await billing().getInvoice(owner, prepared.id);
      expect(current.status).toBe('draft');
      expect(current.invoiceNumber).toBeNull();
    });

    it('lets a group change that waits behind finalization commit after it, leaving the invoice intact', async () => {
      const { member, draft: prepared } = await combinedDraft();
      tick();
      const [finalized, change] = await Promise.allSettled([
        finalizeDraft(prepared),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await leaveGroup(member);
        })(),
      ]);
      expect(change.status).toBe('fulfilled');
      const current = await billing().getInvoice(owner, prepared.id);
      if (finalized.status === 'fulfilled') {
        // Finalization won: the snapshot names the member as it was.
        expect(current.status).toBe('finalized');
        expect(current.items[1]?.client?.id).toBe(member.id);
      } else {
        // The group change won: finalization saw it and refused.
        expect(finalized.reason).toMatchObject({ code: 'INVOICE_GROUP_CHANGED' });
        expect(current.status).toBe('draft');
      }
    });

    it('enforces the combined line rules in the database', async () => {
      const { head, member, memberCase, draft: prepared } = await combinedDraft();
      const outsider = await client(null);
      const outsiderCase = await caseFor(outsider.id);
      const insertLine = (
        clientId: string | null,
        caseId: string | null,
        invoiceId = prepared.id,
      ) =>
        sql(
          `INSERT INTO invoice_items (id, invoice_id, position, description, quantity, unit_amount_minor,
             line_total_minor, client_id, case_id, created_at)
           VALUES ($1, $2, 99, 'Direct', 1, 1, 1, $3, $4, now())`,
          [newUuidV7(), invoiceId, clientId, caseId],
        );
      await expect(insertLine(null, null)).rejects.toThrow(/names its client/u);
      await expect(insertLine(outsider.id, null)).rejects.toThrow(/member of the group/u);
      await expect(insertLine(member.id, outsiderCase.id)).rejects.toThrow(/line's client/u);
      await expect(insertLine(head.id, memberCase.id)).rejects.toThrow(/line's client/u);

      // Individual invoices keep their rules and never name a line client.
      const individual = await draft(100_000);
      await expect(insertLine(head.id, null, individual.id)).rejects.toThrow(
        /only a combined invoice/u,
      );
      await expect(
        sql("UPDATE invoices SET billing_mode = 'combined' WHERE id = $1", [individual.id]),
      ).rejects.toThrow(/immutable/u);
      await expect(
        sql('UPDATE invoices SET case_id = $2 WHERE id = $1', [prepared.id, memberCase.id]),
      ).rejects.toThrow();
    });

    it('raises the typed rule error from the repository when the database rejects a combined invoice', async () => {
      const { draft: prepared } = await combinedDraft();
      const outsider = await client(null);
      // No snapshots were taken, so the finalization trigger refuses (one statement, nothing kept).
      await expect(
        repositories.invoices.finalize({
          id: prepared.id,
          finalization: {
            invoiceNumber: 'INV-90002',
            issueDate: '2026-03-01',
            finalizedAt: tick(),
            finalizedBy: owner.userId,
          },
          expectedVersion: prepared.version,
          at: tick(),
        }),
      ).rejects.toBeInstanceOf(CombinedInvoiceRuleError);
      // A line for a client outside the group. Outside a unit of work the
      // version bump before the line insert is kept, which this test ignores.
      const items = await repositories.invoices.listItems(prepared.id);
      await expect(
        repositories.invoices.replaceDraft({
          id: prepared.id,
          changes: {
            subtotalMinor: 1_000,
            discountMinor: 0,
            totalMinor: 1_000,
            outstandingMinor: 1_000,
            issueDate: null,
            dueDate: null,
            notes: '',
          },
          items: [{ ...items[0]!, id: newUuidV7(), clientId: outsider.id, caseId: null }],
          expectedVersion: prepared.version,
          at: tick(),
        }),
      ).rejects.toBeInstanceOf(CombinedInvoiceRuleError);
    });

    it('rechecks the group in the database when a combined invoice is finalized', async () => {
      const { member, draft: prepared } = await combinedDraft();
      const finalizeDirectly = () =>
        sql(
          `UPDATE invoices SET status = 'finalized', invoice_number = 'INV-90001', issue_date = '2026-03-01',
             finalized_at = now(), finalized_by = $2, version = version + 1
           WHERE id = $1`,
          [prepared.id, owner.userId],
        );
      // No snapshot yet.
      await expect(finalizeDirectly()).rejects.toThrow(/client snapshot/u);
      await sql(
        `UPDATE invoice_items SET client_code_snapshot = 'CL-99999', client_name_snapshot = 'Snapshot'
         WHERE invoice_id = $1`,
        [prepared.id],
      );
      await leaveGroup(member);
      await expect(finalizeDirectly()).rejects.toThrow(/current member/u);
    });
  });

  describe('database guards', () => {
    it('freezes a finalized invoice and its items, and forbids deletes', async () => {
      const invoice = await finalized(500_000);
      await expect(
        sql(
          'UPDATE invoices SET total_minor = 1, subtotal_minor = 1, outstanding_minor = 1 WHERE id = $1',
          [invoice.id],
        ),
      ).rejects.toThrow();
      await expect(
        sql("UPDATE invoices SET notes = 'x' WHERE id = $1", [invoice.id]),
      ).rejects.toThrow(/immutable/u);
      await expect(
        sql('UPDATE invoices SET invoice_number = $2 WHERE id = $1', [invoice.id, 'INV-99999']),
      ).rejects.toThrow();
      await expect(
        sql("UPDATE invoices SET status = 'draft' WHERE id = $1", [invoice.id]),
      ).rejects.toThrow();
      await expect(sql('DELETE FROM invoices WHERE id = $1', [invoice.id])).rejects.toThrow(
        /never deleted/u,
      );
      await expect(
        sql('DELETE FROM invoice_items WHERE invoice_id = $1', [invoice.id]),
      ).rejects.toThrow(/frozen/u);
      await expect(
        sql("UPDATE invoice_items SET description = 'x' WHERE invoice_id = $1", [invoice.id]),
      ).rejects.toThrow(/frozen/u);
    });

    it('keeps payments and reversals append-only', async () => {
      const invoice = await finalized(500_000);
      const paid = await pay(invoice.id, 200_000);
      const paymentId = paid.value.payment.id;
      await expect(
        sql('UPDATE payments SET amount_minor = 1 WHERE id = $1', [paymentId]),
      ).rejects.toThrow(/immutable/u);
      await expect(sql('DELETE FROM payments WHERE id = $1', [paymentId])).rejects.toThrow(
        /never deleted/u,
      );
      tick();
      await billing().reversePayment({
        actor: owner,
        paymentId,
        idempotencyKey: idem(),
        requestId: rid(),
        request: { amountMinor: 100_000, reason: 'Partial' },
      });
      await expect(
        sql('UPDATE payment_reversals SET amount_minor = 1 WHERE payment_id = $1', [paymentId]),
      ).rejects.toThrow(/append-only/u);
      await expect(
        sql('DELETE FROM payment_reversals WHERE payment_id = $1', [paymentId]),
      ).rejects.toThrow(/append-only/u);
    });

    it('rejects inconsistent balances and payments on drafts or void invoices', async () => {
      const invoice = await finalized(500_000);
      await expect(
        sql('UPDATE invoices SET paid_minor = 100, outstanding_minor = 100 WHERE id = $1', [
          invoice.id,
        ]),
      ).rejects.toThrow();
      const prepared = await draft();
      await expect(
        sql(
          `INSERT INTO payments (id, invoice_id, receipt_number, amount_minor, method, received_on, recorded_by, created_at, updated_at, version)
           VALUES ($1, $2, 'RCP-99998', 1, 'cash', '2026-03-01', $3, now(), now(), 1)`,
          [newUuidV7(), prepared.id, owner.userId],
        ),
      ).rejects.toThrow(/finalized/u);
    });

    it('allows only an unpaid invoice to be voided', async () => {
      const invoice = await finalized(500_000);
      await pay(invoice.id, 100);
      await expect(
        sql(
          "UPDATE invoices SET status = 'void', void_reason = 'x', voided_at = now(), voided_by = $2 WHERE id = $1",
          [invoice.id, owner.userId],
        ),
      ).rejects.toThrow();
    });

    it('rejects a case that belongs to another client', async () => {
      const other = await dependencies.clientService.createClient({
        actor: owner,
        requestId: rid(),
        request: {
          type: 'business',
          legalName: 'Other Billing Client',
          ntn: '7654321',
          contacts: [],
          assignedManagerUserId: owner.userId,
        },
      });
      await expect(
        sql(
          `INSERT INTO invoices (id, client_id, case_id, currency, status, subtotal_minor, discount_minor, total_minor,
             paid_minor, outstanding_minor, payment_status, created_by, created_at, updated_at, version)
           VALUES ($1, $2, $3, 'PKR', 'draft', 0, 0, 0, 0, 0, 'unpaid', $4, now(), now(), 1)`,
          [newUuidV7(), other.id, caseA, owner.userId],
        ),
      ).rejects.toThrow(/same client/u);
    });

    it('keeps the counters gapless and unique in the ledger', async () => {
      const rows = await sql(
        'SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL ORDER BY invoice_number',
      );
      const numbers = rows.map((row) => Number(String(row['invoice_number']).slice(4)));
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
      const receipts = await sql('SELECT receipt_number FROM payments ORDER BY receipt_number');
      const receiptNumbers = receipts.map((row) => Number(String(row['receipt_number']).slice(4)));
      expect(receiptNumbers).toEqual(receiptNumbers.map((_, index) => index + 1));
    });
  });
});

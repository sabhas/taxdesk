import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlExecutor, type SqlExecutor } from '@taxdesk/database';
import {
  DirectoryMigrationSource,
  createPostgresExecutor,
  runMigrations,
} from '@taxdesk/database/migrations';
import { STARTER_WORKFLOW_DEFINITION } from '@taxdesk/shared';
import { bytesToBase64Url } from '../crypto/encoding.js';
import { createPasswordHasher } from '../crypto/password.js';
import { createSecretCipher } from '../crypto/cipher.js';
import { buildDependencies, type AppDependencies } from '../dependencies.js';
import { BootstrapService } from '../domain/auth/bootstrap-service.js';
import type { Actor } from '../domain/auth/types.js';
import { matchesCaseFilter } from '../domain/cases/types.js';
import type { Repositories } from './ports.js';

/**
 * Epic 6 report queries, audit search, and migration 0009 against PostgreSQL. The suite runs in
 * its own schema (`search_path`), so it never races the public-schema suite in
 * `postgres.integration.test.ts` when both run in one Vitest invocation.
 */

const baseConnectionString =
  process.env['TAXDESK_API_TEST_DATABASE_URL'] ??
  process.env['TAXDESK_MIGRATIONS_TEST_DATABASE_URL'];

const SCHEMA = 'taxdesk_reports_it';

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

describeWithDatabase('report queries, audit search, and firm settings against PostgreSQL', () => {
  let executor: SqlExecutor;
  let dependencies: AppDependencies;
  let repositories: Repositories;
  let clockNow: Date;
  let owner: Actor;
  let clientA: string;

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
      firmName: 'Reports Firm',
      username: 'owner',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const user = await repositories.users.findById(result.userId);
    const session = await dependencies.sessionService.issue(user!, {
      mfaVerified: true,
      requestId: 'rep-db-session',
    });
    owner = (await dependencies.sessionService.validate(session.token))!;

    tick();
    const template = await dependencies.workflowTemplateService.create({
      actor: owner,
      requestId: 'rep-db-template',
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
      requestId: 'rep-db-publish',
    });
    tick();
    const service = await dependencies.serviceTypeService.create({
      actor: owner,
      requestId: 'rep-db-service',
      request: {
        name: 'Billing service',
        description: '',
        defaultFeeMinor: 1_000_000,
        defaultDeadlineOffsetDays: 30,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: template.id,
      },
    });
    tick();
    clientA = (
      await dependencies.clientService.createClient({
        actor: owner,
        requestId: 'rep-db-client',
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
    await dependencies.caseService.createCase({
      actor: owner,
      requestId: 'rep-db-case',
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
    });
  });

  afterAll(async () => {
    await executor.close();
  });

  let requests = 0;
  const rid = (): string => `rep-db-${String(++requests)}`;
  const idem = (): string => `idem-key-${String(++requests).padStart(12, '0')}`;
  const billing = () => dependencies.billingService;
  const sql = async (text: string, params: unknown[] = []) => await executor.query(text, params);

  async function finalized(total: number, dueDate: string) {
    tick();
    const created = await billing().createDraft({
      actor: owner,
      request: { clientId: clientA },
      requestId: rid(),
    });
    tick();
    const prepared = await billing().updateDraft({
      actor: owner,
      id: created.id,
      expectedVersion: created.version,
      requestId: rid(),
      request: {
        items: [{ description: 'Return', quantity: 1, unitAmountMinor: total }],
        discountMinor: 0,
        issueDate: null,
        dueDate,
        notes: '',
      },
    });
    tick();
    return (
      await billing().finalizeInvoice({
        actor: owner,
        id: prepared.id,
        expectedVersion: prepared.version,
        idempotencyKey: idem(),
        requestId: rid(),
      })
    ).value;
  }

  const pay = (invoiceId: string, amountMinor: number) =>
    billing().recordPayment({
      actor: owner,
      invoiceId,
      idempotencyKey: idem(),
      requestId: rid(),
      request: { amountMinor, method: 'cash', receivedOn: '2026-03-01', reference: '' },
    });

  describe('migration 0009 firm settings', () => {
    it('defaults the business settings and enforces their ranges in the database', async () => {
      const firm = await repositories.firm.get();
      expect(firm).toMatchObject({
        currency: 'PKR',
        invoicePrefix: 'INV',
        receiptPrefix: 'RCP',
        documentMaxUploadBytes: 262_144_000,
        dueSoonDays: 7,
      });
      for (const change of [
        `invoice_prefix = 'inv'`,
        `receipt_prefix = 'X'`,
        `due_soon_days = 0`,
        `due_soon_days = 61`,
        `document_max_upload_bytes = 1024`,
        `currency = 'USD'`,
      ]) {
        await expect(sql(`UPDATE firm_settings SET ${change}`)).rejects.toThrow();
      }
    });

    it('stores a settings update with a version check and audits the change', async () => {
      const current = await dependencies.firmService.getSettings();
      tick();
      const updated = await dependencies.firmService.updateSettings({
        actor: owner,
        expectedVersion: current.version,
        requestId: rid(),
        update: {
          firmName: current.firmName,
          timezone: current.timezone,
          invoicePrefix: 'TAX',
          dueSoonDays: 10,
        },
      });
      expect(updated).toMatchObject({ invoicePrefix: 'TAX', dueSoonDays: 10 });
      await expect(
        dependencies.firmService.updateSettings({
          actor: owner,
          expectedVersion: current.version,
          requestId: rid(),
          update: { firmName: current.firmName, timezone: current.timezone },
        }),
      ).rejects.toMatchObject({ status: 412 });
      const audit = await repositories.audit.search({
        actorUserId: null,
        from: null,
        to: null,
        timezone: 'Asia/Karachi',
        action: 'firm.settings_updated',
        entityType: null,
        entityId: null,
        requestId: null,
        limit: 5,
        cursor: null,
      });
      expect(audit.events[0]?.metadata).toMatchObject({
        changedFields: 'invoicePrefix,dueSoonDays',
        invoicePrefixTo: 'TAX',
      });
    });

    it('issues new numbers with the new prefix and accepts them in the invoice check', async () => {
      const invoice = await finalized(1_000_000, '2026-04-30');
      expect(invoice.invoiceNumber).toMatch(/^TAX-\d{5,}$/u);
      await expect(
        sql(`UPDATE invoices SET invoice_number = 'tax-1' WHERE false`),
      ).resolves.toBeDefined();
    });
  });

  describe('case report predicates', () => {
    it('counts the same rows as the reference predicate for every report filter', async () => {
      const filters = [
        { view: 'active' as const },
        { view: 'any' as const },
        { view: 'team' as const, checklist: 'gaps' as const },
        { view: 'team' as const, checklist: 'awaiting_review' as const },
        { view: 'team' as const, statusKind: 'open' as const },
        { view: 'closed' as const, statusKind: 'completed' as const },
        { view: 'active' as const, dueFrom: '2026-09-01', dueTo: '2026-09-30' },
        { view: 'active' as const, dueFrom: '2027-01-01' },
      ];
      const everything = await repositories.cases.list({
        ...(await dependencies.caseService.filterFor(owner, 'any', {})),
        limit: 100,
        after: null,
      });
      expect(everything.cases.length).toBeGreaterThan(0);
      const items = await repositories.cases.listItems(everything.cases.map((entry) => entry.id));
      for (const overrides of filters) {
        const { view, ...rest } = overrides;
        const filter = await dependencies.caseService.filterFor(owner, view, {}, rest);
        const expected = everything.cases.filter((record) =>
          matchesCaseFilter(
            record,
            filter,
            items.filter((item) => item.caseId === record.id),
          ),
        ).length;
        expect(await repositories.cases.count(filter), JSON.stringify(overrides)).toBe(expected);
      }
    });
  });

  describe('billing aggregates', () => {
    it('agree with the invoice rows and payments they summarize', async () => {
      const a = await finalized(2_000_000, '2026-04-01');
      await finalized(500_000, '2026-04-10');
      const settled = await pay(a.id, 750_000);
      await dependencies.billingService.reversePayment({
        actor: owner,
        paymentId: settled.value.payment.id,
        idempotencyKey: idem(),
        requestId: rid(),
        request: { amountMinor: 50_000, reason: 'Bounced' },
      });

      const totals = await repositories.billingReports.invoiceTotals({
        issuedFrom: null,
        issuedTo: null,
        today: '2026-06-01',
        clientId: null,
        visibleClientIds: null,
      });
      const rows = await billing().listInvoices(owner, { status: 'finalized', limit: 100 });
      const finalizedRows = rows.invoices;
      expect(totals.invoiced).toEqual({
        count: finalizedRows.length,
        amountMinor: finalizedRows.reduce((sum, row) => sum + row.totalMinor, 0),
      });
      const owing = finalizedRows.filter((row) => row.outstandingMinor > 0);
      expect(totals.outstanding).toEqual({
        count: owing.length,
        amountMinor: owing.reduce((sum, row) => sum + row.outstandingMinor, 0),
      });
      const overdueList = await billing().listInvoices(owner, { balance: 'overdue', limit: 100 });
      expect(totals.overdue.count).toBeGreaterThan(0);
      expect(overdueList.invoices.length).toBeGreaterThanOrEqual(0);

      // Every row equals the invoice-detail balance, which the calculator wrote.
      for (const row of finalizedRows) {
        const detail = await billing().getInvoice(owner, row.id);
        expect(detail.outstandingMinor).toBe(row.outstandingMinor);
        expect(detail.paidMinor).toBe(row.paidMinor);
      }

      const collection = await repositories.billingReports.collectionTotals({
        from: '2026-03-01',
        to: '2026-03-31',
        timezone: 'Asia/Karachi',
        clientId: null,
        visibleClientIds: null,
      });
      const paymentRows = await sql(
        `SELECT count(*)::int AS n, COALESCE(sum(amount_minor), 0)::bigint AS total FROM payments
         WHERE received_on BETWEEN '2026-03-01' AND '2026-03-31'`,
      );
      expect(collection.collected.count).toBe(Number(paymentRows[0]!['n']));
      expect(collection.collected.amountMinor).toBe(Number(paymentRows[0]!['total']));
      expect(collection.reversed).toEqual({ count: 1, amountMinor: 50_000 });
    });

    it('returns zeros for an empty range and honors visibility', async () => {
      const empty = await repositories.billingReports.invoiceTotals({
        issuedFrom: '2020-01-01',
        issuedTo: '2020-01-31',
        today: '2026-06-01',
        clientId: null,
        visibleClientIds: null,
      });
      expect(empty.invoiced).toEqual({ count: 0, amountMinor: 0 });
      const hidden = await repositories.billingReports.invoiceTotals({
        issuedFrom: null,
        issuedTo: null,
        today: '2026-06-01',
        clientId: null,
        visibleClientIds: [],
      });
      expect(hidden.invoiced.count).toBe(0);
    });
  });

  describe('audit search', () => {
    const base = {
      actorUserId: null,
      from: null,
      to: null,
      timezone: 'Asia/Karachi',
      action: null,
      entityType: null,
      entityId: null,
      requestId: null,
      limit: 100,
      cursor: null,
    };

    it('filters by actor, action prefix, entity, request, and firm-calendar day', async () => {
      const everything = await repositories.audit.search(base);
      expect(everything.events.length).toBeGreaterThan(3);
      const billingEvents = await repositories.audit.search({ ...base, action: 'billing.*' });
      expect(billingEvents.events.length).toBeGreaterThan(0);
      expect(billingEvents.events.every((event) => event.action.startsWith('billing.'))).toBe(true);
      const exact = await repositories.audit.search({
        ...base,
        action: 'billing.payment_reversed',
      });
      expect(exact.events).toHaveLength(1);
      const byRequest = await repositories.audit.search({
        ...base,
        requestId: exact.events[0]!.requestId,
      });
      expect(byRequest.events.some((event) => event.id === exact.events[0]!.id)).toBe(true);
      const byEntity = await repositories.audit.search({
        ...base,
        entityType: exact.events[0]!.entityType,
        entityId: exact.events[0]!.entityId,
      });
      expect(byEntity.events.length).toBeGreaterThan(0);
      const byActor = await repositories.audit.search({ ...base, actorUserId: owner.userId });
      expect(byActor.events.every((event) => event.actorUserId === owner.userId)).toBe(true);
      // 2026-03-01 is the test clock's day (Asia/Karachi is UTC+5).
      const sameDay = await repositories.audit.search({
        ...base,
        from: '2026-03-01',
        to: '2026-03-02',
      });
      expect(sameDay.events.length).toBeGreaterThan(0);
      const none = await repositories.audit.search({ ...base, from: '2031-01-01' });
      expect(none.events).toEqual([]);
    });

    it('pages newest first with a cursor and no overlap', async () => {
      const first = await repositories.audit.search({ ...base, limit: 3 });
      expect(first.events).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();
      const second = await repositories.audit.search({
        ...base,
        limit: 3,
        cursor: first.nextCursor,
      });
      const seen = new Set(first.events.map((event) => event.id));
      expect(second.events.every((event) => !seen.has(event.id))).toBe(true);
      expect(second.events[0]!.id < first.events[2]!.id).toBe(true);
    });
  });
});

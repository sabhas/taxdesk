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
import type {
  DocumentListFilter,
  DocumentRecord,
  DocumentUploadRecord,
} from '../domain/documents/types.js';
import type {
  ReconciliationRunRecord,
  StorageConnectionRecord,
  StorageOAuthStateRecord,
} from '../domain/storage/types.js';
import {
  createInMemoryDocumentRepository,
  createInMemoryDocumentState,
} from './in-memory-documents.js';
import { DuplicateDocumentUploadError, type Repositories } from './ports.js';

/**
 * Epic 4 repositories and migration 0007 against PostgreSQL. The suite runs in
 * its own schema (`search_path`), so it never races the public-schema suite in
 * `postgres.integration.test.ts` when both run in one Vitest invocation.
 */

const baseConnectionString =
  process.env['TAXDESK_API_TEST_DATABASE_URL'] ??
  process.env['TAXDESK_MIGRATIONS_TEST_DATABASE_URL'];

const SCHEMA = 'taxdesk_documents_it';

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

describeWithDatabase('document storage repositories against PostgreSQL', () => {
  let executor: SqlExecutor;
  let dependencies: AppDependencies;
  let repositories: Repositories;
  let clockNow: Date;
  let owner: Actor;
  let clientA: string;
  let clientB: string;
  let caseA: string;
  let caseB: string;
  let itemA: string;
  let itemA2: string;
  let itemB: string;

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
      firmName: 'Documents Firm',
      username: 'owner',
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const user = await repositories.users.findById(result.userId);
    const session = await dependencies.sessionService.issue(user!, {
      mfaVerified: true,
      requestId: 'doc-db-session',
    });
    owner = (await dependencies.sessionService.validate(session.token))!;

    tick();
    const template = await dependencies.workflowTemplateService.create({
      actor: owner,
      requestId: 'doc-db-template',
      request: {
        name: 'Documents workflow',
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
      requestId: 'doc-db-publish',
    });
    tick();
    const service = await dependencies.serviceTypeService.create({
      actor: owner,
      requestId: 'doc-db-service',
      request: {
        name: 'Documents service',
        description: '',
        defaultFeeMinor: 1_000_000,
        defaultDeadlineOffsetDays: 30,
        duplicateCasePolicy: 'warn',
        defaultWorkflowTemplateId: template.id,
      },
    });
    const makeClient = async (name: string, ntn: string): Promise<string> => {
      tick();
      const client = await dependencies.clientService.createClient({
        actor: owner,
        requestId: `doc-db-client-${ntn}`,
        request: {
          type: 'business',
          legalName: name,
          ntn,
          contacts: [],
          assignedManagerUserId: owner.userId,
        },
      });
      return client.id;
    };
    clientA = await makeClient('Documents Client A', '1234567');
    clientB = await makeClient('Documents Client B', '2345678');
    const makeCase = async (clientId: string): Promise<string> => {
      tick();
      const created = await dependencies.caseService.createCase({
        actor: owner,
        requestId: `doc-db-case-${clientId}`,
        request: {
          clientId,
          serviceTypeId: service.id,
          taxYear: 2025,
          workflowVersionId: version.id,
          dueDate: '2026-09-30',
          primaryConsultantUserId: owner.userId,
          reviewerUserId: null,
          notes: '',
        },
      });
      return created.id;
    };
    caseA = await makeCase(clientA);
    caseB = await makeCase(clientB);
    const items = await repositories.cases.listItems([caseA, caseB]);
    const forA = items.filter((item) => item.caseId === caseA);
    itemA = forA[0]!.id;
    itemA2 = forA[1]!.id;
    itemB = items.find((item) => item.caseId === caseB)!.id;
  });

  afterAll(async () => {
    await executor.close();
  });

  function documentRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
    const at = overrides.uploadedAt ?? tick();
    const id = overrides.id ?? newUuidV7(new Date(at).getTime());
    return {
      id,
      clientId: clientA,
      caseId: caseA,
      checklistItemId: itemA,
      documentType: 'Bank statement',
      fileName: 'statement.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      providerType: 'fake',
      externalItemId: `item-${id}`,
      externalDriveId: 'fake-drive',
      externalParentId: 'folder:1',
      externalEtag: '"1"',
      verificationState: 'pending',
      verificationNote: null,
      verifiedBy: null,
      verifiedAt: null,
      providerState: 'present',
      lastReconciledAt: null,
      uploadId: newUuidV7(),
      uploadedBy: owner.userId,
      uploadedAt: at,
      deletedAt: null,
      deletedBy: null,
      createdAt: at,
      updatedAt: at,
      version: 1,
      ...overrides,
    };
  }

  function uploadRecord(overrides: Partial<DocumentUploadRecord> = {}): DocumentUploadRecord {
    const at = tick();
    return {
      id: newUuidV7(),
      documentId: newUuidV7(),
      clientId: clientA,
      caseId: caseA,
      checklistItemId: itemA,
      documentType: 'Bank statement',
      fileName: 'statement.pdf',
      contentType: 'application/pdf',
      sizeBytes: 12 * 1024 * 1024,
      providerType: 'fake',
      sessionCiphertext: 'v1.iv.ciphertext',
      sessionKeyVersion: 1,
      nextOffset: 0,
      state: 'active',
      externalItemId: null,
      createdBy: owner.userId,
      requestId: `upload-${newUuidV7()}`,
      createdAt: at,
      expiresAt: new Date(clockNow.getTime() + 86_400_000).toISOString(),
      completedAt: null,
      updatedAt: at,
      version: 1,
      ...overrides,
    };
  }

  describe('storage connection', () => {
    function connection(): StorageConnectionRecord {
      const at = tick();
      return {
        id: newUuidV7(),
        providerType: 'fake',
        status: 'healthy',
        healthReason: null,
        externalDriveId: 'fake-drive',
        externalRootFolderId: 'fake-root',
        accountLabel: 'Fake storage account',
        tokenCiphertext: 'v1.iv.token',
        tokenKeyVersion: 1,
        accessTokenExpiresAt: new Date(clockNow.getTime() + 3_600_000).toISOString(),
        connectedAt: at,
        connectedBy: owner.userId,
        lastCheckedAt: at,
        lastRefreshedAt: null,
        disconnectedAt: null,
        disconnectedBy: null,
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
    }

    it('stores a single row, updates optimistically, and enforces token parts', async () => {
      expect(await repositories.storageConnections.get()).toBeNull();
      const record = connection();
      await repositories.storageConnections.create(record);
      expect(await repositories.storageConnections.get()).toEqual(record);
      await expect(repositories.storageConnections.create(connection())).rejects.toMatchObject({
        code: '23505',
      });

      const at = tick();
      const updated = await repositories.storageConnections.update({
        id: record.id,
        changes: { status: 'unavailable', healthReason: 'provider_unavailable', lastCheckedAt: at },
        expectedVersion: 1,
        at,
      });
      expect(updated).toMatchObject({
        status: 'unavailable',
        healthReason: 'provider_unavailable',
        version: 2,
        updatedAt: at,
        tokenCiphertext: 'v1.iv.token',
      });
      expect(
        await repositories.storageConnections.update({
          id: record.id,
          changes: { status: 'healthy' },
          expectedVersion: 1,
          at: tick(),
        }),
      ).toBeNull();

      // A connected row must keep its token; a disconnected row may not keep one.
      await expect(
        repositories.storageConnections.update({
          id: record.id,
          changes: { tokenCiphertext: null, tokenKeyVersion: null },
          expectedVersion: 2,
          at: tick(),
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        repositories.storageConnections.update({
          id: record.id,
          changes: { status: 'not_connected' },
          expectedVersion: 2,
          at: tick(),
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        repositories.storageConnections.update({
          id: record.id,
          changes: { tokenKeyVersion: null },
          expectedVersion: 2,
          at: tick(),
        }),
      ).rejects.toMatchObject({ code: '23514' });

      const disconnected = await repositories.storageConnections.update({
        id: record.id,
        changes: {
          status: 'not_connected',
          tokenCiphertext: null,
          tokenKeyVersion: null,
          disconnectedAt: clockNow.toISOString(),
          disconnectedBy: owner.userId,
        },
        expectedVersion: 2,
        at: tick(),
      });
      expect(disconnected).toMatchObject({
        status: 'not_connected',
        tokenCiphertext: null,
        version: 3,
      });

      await repositories.storageConnections.update({
        id: record.id,
        changes: { status: 'healthy', tokenCiphertext: 'v1.iv.token2', tokenKeyVersion: 1 },
        expectedVersion: 3,
        at: tick(),
      });
    });

    it('serializes concurrent writers through lock()', async () => {
      const start = (await repositories.storageConnections.get())!;
      const order: string[] = [];
      const writer = (label: string) =>
        dependencies.unitOfWork.run(async (tx) => {
          const locked = (await tx.storageConnections.lock())!;
          order.push(`${label}:locked`);
          await new Promise((resolve) => setTimeout(resolve, 150));
          const next = await tx.storageConnections.update({
            id: locked.id,
            changes: { tokenCiphertext: `v1.iv.${label}` },
            expectedVersion: locked.version,
            at: new Date().toISOString(),
          });
          order.push(`${label}:written`);
          return next;
        });
      const [first, second] = await Promise.all([writer('a'), writer('b')]);
      // Without the row lock both would read the same version and one update would miss.
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(order[1]).toMatch(/:written$/u);
      const finalRow = (await repositories.storageConnections.get())!;
      expect(finalRow.version).toBe(start.version + 2);
    });
  });

  describe('OAuth state', () => {
    function oauthState(overrides: Partial<StorageOAuthStateRecord> = {}): StorageOAuthStateRecord {
      const at = tick();
      return {
        id: newUuidV7(),
        stateHash: `hash-${newUuidV7()}`,
        codeVerifierCiphertext: 'v1.iv.verifier',
        keyVersion: 1,
        providerType: 'fake',
        createdBy: owner.userId,
        createdAt: at,
        expiresAt: new Date(clockNow.getTime() + 600_000).toISOString(),
        consumedAt: null,
        ...overrides,
      };
    }

    it('finds by hash, consumes once (even concurrently), and prunes expired rows', async () => {
      const record = oauthState();
      await repositories.storageOAuthStates.create(record);
      expect(await repositories.storageOAuthStates.findByStateHash(record.stateHash)).toEqual(
        record,
      );
      expect(
        await repositories.storageOAuthStates.findByStateHash('hash-unknown-value'),
      ).toBeNull();
      await expect(
        repositories.storageOAuthStates.create(oauthState({ stateHash: record.stateHash })),
      ).rejects.toMatchObject({ code: '23505' });

      const raced = oauthState();
      await repositories.storageOAuthStates.create(raced);
      const results = await Promise.all([
        repositories.storageOAuthStates.consume(raced.id, tick()),
        repositories.storageOAuthStates.consume(raced.id, tick()),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repositories.storageOAuthStates.consume(raced.id, tick())).toBe(false);
      expect(
        (await repositories.storageOAuthStates.findByStateHash(raced.stateHash))?.consumedAt,
      ).not.toBeNull();

      const pruned = await repositories.storageOAuthStates.pruneBefore(
        new Date(clockNow.getTime() + 3_600_000).toISOString(),
      );
      expect(pruned).toBeGreaterThanOrEqual(2);
      expect(await repositories.storageOAuthStates.findByStateHash(record.stateHash)).toBeNull();
    });
  });

  describe('documents', () => {
    it('round-trips a document, including sizes beyond 32 bits', async () => {
      const record = documentRecord({ sizeBytes: 5_000_000_000 });
      await repositories.documents.create(record);
      expect(await repositories.documents.findById(record.id)).toEqual(record);
      expect(await repositories.documents.findByUploadId(record.uploadId)).toEqual(record);
      expect(
        await dependencies.unitOfWork.run(async (tx) => await tx.documents.lockById(record.id)),
      ).toEqual(record);
      expect(await repositories.documents.findById(newUuidV7())).toBeNull();
    });

    it('rejects a second document from the same upload', async () => {
      const record = documentRecord();
      await repositories.documents.create(record);
      await expect(
        repositories.documents.create(documentRecord({ uploadId: record.uploadId })),
      ).rejects.toBeInstanceOf(DuplicateDocumentUploadError);
    });

    it('updates optimistically and keeps review parts consistent', async () => {
      const record = documentRecord();
      await repositories.documents.create(record);
      const at = tick();
      const verified = await repositories.documents.update({
        id: record.id,
        changes: {
          verificationState: 'verified',
          verifiedBy: owner.userId,
          verifiedAt: at,
          verificationNote: 'Looks right',
        },
        expectedVersion: 1,
        at,
      });
      expect(verified).toMatchObject({ verificationState: 'verified', version: 2, updatedAt: at });
      expect(
        await repositories.documents.update({
          id: record.id,
          changes: { documentType: 'Other' },
          expectedVersion: 1,
          at: tick(),
        }),
      ).toBeNull();
      await expect(
        repositories.documents.update({
          id: record.id,
          changes: { verifiedAt: null },
          expectedVersion: 2,
          at: tick(),
        }),
      ).rejects.toMatchObject({ code: '23514' });
      const unlinked = await repositories.documents.update({
        id: record.id,
        changes: { checklistItemId: null, documentType: 'Other' },
        expectedVersion: 2,
        at: tick(),
      });
      expect(unlinked).toMatchObject({ checklistItemId: null, documentType: 'Other', version: 3 });
    });

    it('enforces document triggers: no delete, immutable facts, matching links', async () => {
      const record = documentRecord();
      await repositories.documents.create(record);
      await expect(
        executor.query('DELETE FROM documents WHERE id = $1', [record.id]),
      ).rejects.toMatchObject({ code: '23001' });
      await expect(
        executor.query('UPDATE documents SET client_id = $2 WHERE id = $1', [record.id, clientB]),
      ).rejects.toMatchObject({ code: '23001' });
      await expect(
        executor.query("UPDATE documents SET external_item_id = 'other' WHERE id = $1", [
          record.id,
        ]),
      ).rejects.toMatchObject({ code: '23001' });
      // A case of another client.
      await expect(
        repositories.documents.create(documentRecord({ caseId: caseB, checklistItemId: null })),
      ).rejects.toMatchObject({ code: '23514' });
      // A checklist item of another case.
      await expect(
        repositories.documents.create(documentRecord({ checklistItemId: itemB })),
      ).rejects.toMatchObject({ code: '23514' });
      // A checklist item without a case.
      await expect(
        repositories.documents.create(documentRecord({ caseId: null, checklistItemId: itemA })),
      ).rejects.toMatchObject({ code: '23514' });
      // Soft delete is allowed.
      const at = tick();
      const deleted = await repositories.documents.update({
        id: record.id,
        changes: { deletedAt: at, deletedBy: owner.userId },
        expectedVersion: 1,
        at,
      });
      expect(deleted?.deletedAt).toBe(at);
    });

    it('lists, filters, and pages exactly like the in-memory repository', async () => {
      // Fresh documents for a dedicated client so other tests do not interfere.
      const memoryState = createInMemoryDocumentState();
      const memory = createInMemoryDocumentRepository(memoryState);
      for (const existing of await executor.query('SELECT id FROM documents')) {
        const found = await repositories.documents.findById(String(existing['id']));
        await memory.create(found!);
      }
      const shared = tick();
      const variants: Partial<DocumentRecord>[] = [
        { clientId: clientB, caseId: caseB, checklistItemId: itemB },
        { clientId: clientB, caseId: null, checklistItemId: null },
        {
          checklistItemId: itemA2,
          verificationState: 'rejected',
          verifiedAt: shared,
          verifiedBy: owner.userId,
        },
        { caseId: null, checklistItemId: null },
        { uploadedAt: shared },
        { uploadedAt: shared, clientId: clientB, caseId: caseB, checklistItemId: null },
        { uploadedAt: shared, verificationState: 'missing_provider', providerState: 'missing' },
        { deletedAt: shared, deletedBy: owner.userId },
        {
          clientId: clientB,
          caseId: null,
          checklistItemId: null,
          deletedAt: shared,
          deletedBy: owner.userId,
        },
      ];
      for (let round = 0; round < 2; round += 1) {
        for (const variant of variants) {
          const record = documentRecord(variant);
          await repositories.documents.create(record);
          await memory.create(record);
        }
      }

      const filters: Omit<DocumentListFilter, 'limit' | 'cursor'>[] = [
        { state: 'all' },
        { state: 'active' },
        { state: 'deleted' },
        { clientId: clientA, state: 'active' },
        { clientId: clientB, state: 'all' },
        { caseId: caseA, state: 'active' },
        { checklistItemId: itemA, state: 'active' },
        { clientId: clientA, verificationState: 'rejected', state: 'all' },
        { state: 'active', visibleTo: { clientIds: [clientB], caseIds: [caseA] } },
        { state: 'all', visibleTo: { clientIds: [], caseIds: [caseB] } },
        { state: 'all', visibleTo: { clientIds: [], caseIds: [] } },
      ];
      for (const filter of filters) {
        for (const limit of [1, 3, 100]) {
          let pgCursor: string | null = null;
          let memoryCursor: string | null = null;
          for (let page = 0; page < 60; page += 1) {
            const pgPage = await repositories.documents.list({
              ...filter,
              limit,
              cursor: pgCursor,
            });
            const memoryPage = await memory.list({ ...filter, limit, cursor: memoryCursor });
            expect(pgPage.documents.map((doc) => doc.id)).toEqual(
              memoryPage.documents.map((doc) => doc.id),
            );
            expect(pgPage.nextCursor).toEqual(memoryPage.nextCursor);
            if (pgPage.nextCursor === null) {
              break;
            }
            pgCursor = pgPage.nextCursor;
            memoryCursor = memoryPage.nextCursor;
          }
        }
      }

      const items = [itemA, itemB];
      expect(
        (await repositories.documents.listForChecklistItems(items)).map((doc) => doc.id),
      ).toEqual((await memory.listForChecklistItems(items)).map((doc) => doc.id));
      expect(await repositories.documents.listForChecklistItems([])).toEqual([]);

      let pgAfter: string | null = null;
      let memoryAfter: string | null = null;
      for (let page = 0; page < 60; page += 1) {
        const pgBatch = await repositories.documents.listForReconciliation({
          afterId: pgAfter,
          limit: 4,
        });
        const memoryBatch = await memory.listForReconciliation({ afterId: memoryAfter, limit: 4 });
        expect(pgBatch.map((doc) => doc.id)).toEqual(memoryBatch.map((doc) => doc.id));
        expect(pgBatch.every((doc) => doc.deletedAt === null)).toBe(true);
        if (pgBatch.length === 0) {
          break;
        }
        pgAfter = pgBatch.at(-1)!.id;
        memoryAfter = memoryBatch.at(-1)!.id;
      }
    });
  });

  describe('uploads', () => {
    it('round-trips, finds by request, updates optimistically, and checks offsets', async () => {
      const record = uploadRecord();
      await repositories.documentUploads.create(record);
      expect(await repositories.documentUploads.findById(record.id)).toEqual(record);
      expect(
        await repositories.documentUploads.findByRequest(owner.userId, record.requestId),
      ).toEqual(record);
      expect(await repositories.documentUploads.findByRequest(owner.userId, 'unknown')).toBeNull();
      await expect(
        repositories.documentUploads.create(uploadRecord({ requestId: record.requestId })),
      ).rejects.toMatchObject({ code: '23505' });

      const at = tick();
      const advanced = await repositories.documentUploads.update({
        id: record.id,
        changes: { nextOffset: 5 * 1024 * 1024 },
        expectedVersion: 1,
        at,
      });
      expect(advanced).toMatchObject({ nextOffset: 5 * 1024 * 1024, version: 2 });
      expect(
        await repositories.documentUploads.update({
          id: record.id,
          changes: { nextOffset: 0 },
          expectedVersion: 1,
          at: tick(),
        }),
      ).toBeNull();
      await expect(
        repositories.documentUploads.update({
          id: record.id,
          changes: { nextOffset: record.sizeBytes + 1 },
          expectedVersion: 2,
          at: tick(),
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        repositories.documentUploads.update({
          id: record.id,
          changes: { state: 'completed' },
          expectedVersion: 2,
          at: tick(),
        }),
      ).rejects.toMatchObject({ code: '23514' });
      const completedAt = tick();
      const completed = await dependencies.unitOfWork.run(async (tx) => {
        const locked = (await tx.documentUploads.lockById(record.id))!;
        return await tx.documentUploads.update({
          id: locked.id,
          changes: {
            state: 'completed',
            completedAt,
            nextOffset: record.sizeBytes,
            externalItemId: 'item-complete',
            sessionCiphertext: null,
            sessionKeyVersion: null,
          },
          expectedVersion: locked.version,
          at: completedAt,
        });
      });
      expect(completed).toMatchObject({
        state: 'completed',
        completedAt,
        externalItemId: 'item-complete',
        sessionCiphertext: null,
        version: 3,
      });
    });
  });

  describe('reconciliation runs', () => {
    it('appends, lists newest first, and rejects edits and deletes', async () => {
      const run = (startedAt: string): ReconciliationRunRecord => ({
        id: newUuidV7(new Date(startedAt).getTime()),
        state: 'completed',
        startedBy: owner.userId,
        startedAt,
        finishedAt: startedAt,
        connectionStatus: 'healthy',
        checkedCount: 3,
        presentCount: 2,
        missingCount: 1,
        movedCount: 0,
        recoveredCount: 0,
        nextAction: 'review_missing_documents',
        requestId: `run-${startedAt}`,
      });
      const older = run(tick());
      const newer = run(tick());
      await repositories.reconciliationRuns.append(older);
      await repositories.reconciliationRuns.append(newer);
      expect(await repositories.reconciliationRuns.listRecent(10)).toEqual([newer, older]);
      expect(await repositories.reconciliationRuns.listRecent(1)).toEqual([newer]);
      await expect(
        executor.query('UPDATE storage_reconciliation_runs SET missing_count = 0 WHERE id = $1', [
          older.id,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        executor.query('DELETE FROM storage_reconciliation_runs WHERE id = $1', [older.id]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});

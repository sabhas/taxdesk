import { newUuidV7 } from '@taxdesk/shared';
import type { DocumentRecord } from '../domain/documents/types.js';
import type { TestHarness } from './harness.js';

/** What the fixtures need: a clock and repositories (a test harness, or real dependencies). */
type FixtureHost = Pick<TestHarness, 'now' | 'repositories'>;

/**
 * Inserts a verified document record directly (no provider object). Used by
 * case tests that need a document-backed checklist item to be satisfiable
 * without exercising the upload flow.
 */
export async function seedVerifiedDocument(
  harness: FixtureHost,
  input: {
    readonly clientId: string;
    readonly caseId: string | null;
    readonly checklistItemId: string | null;
    readonly uploadedBy: string;
    readonly documentType?: string;
  },
): Promise<DocumentRecord> {
  const at = harness.now().toISOString();
  const id = newUuidV7(harness.now().getTime());
  const record: DocumentRecord = {
    id,
    clientId: input.clientId,
    caseId: input.caseId,
    checklistItemId: input.checklistItemId,
    documentType: input.documentType ?? 'Supporting document',
    fileName: 'synthetic.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    providerType: 'fake',
    externalItemId: `seeded-${id}`,
    externalDriveId: null,
    externalParentId: null,
    externalEtag: null,
    verificationState: 'verified',
    verificationNote: null,
    verifiedBy: input.uploadedBy,
    verifiedAt: at,
    providerState: 'present',
    lastReconciledAt: null,
    uploadId: newUuidV7(harness.now().getTime()),
    uploadedBy: input.uploadedBy,
    uploadedAt: at,
    deletedAt: null,
    deletedBy: null,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
  await harness.repositories.documents.create(record);
  return record;
}

/** Seeds one verified document for every required, document-typed checklist item of a case. */
export async function seedVerifiedDocumentsForCase(
  harness: FixtureHost,
  taxCase: {
    readonly id: string;
    readonly client: { readonly id: string };
    readonly checklist: readonly {
      readonly id: string;
      readonly required: boolean;
      readonly documentType: string | null;
    }[];
  },
  uploadedBy: string,
): Promise<void> {
  for (const item of taxCase.checklist) {
    if (item.required && item.documentType !== null) {
      await seedVerifiedDocument(harness, {
        clientId: taxCase.client.id,
        caseId: taxCase.id,
        checklistItemId: item.id,
        uploadedBy,
        documentType: item.documentType,
      });
    }
  }
}

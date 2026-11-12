import { describe, expect, it } from 'vitest';
import { newUuidV7 } from '@taxdesk/shared';
import { buildDocumentStoragePath, StorageLayoutError } from './storage-layout.js';

describe('stable storage layout (TD-405)', () => {
  const documentId = newUuidV7();
  const caseId = newUuidV7();

  it('derives case paths from client code, tax year, case ID, and document ID', () => {
    expect(
      buildDocumentStoragePath({
        clientCode: 'CL-00042',
        taxYear: 2026,
        caseId,
        documentId,
        fileName: 'Bank statement.pdf',
      }),
    ).toEqual({
      segments: ['clients', 'CL-00042', '2026', caseId, documentId],
      fileName: 'Bank statement.pdf',
    });
  });

  it('files client-level documents under fixed general segments', () => {
    expect(
      buildDocumentStoragePath({
        clientCode: 'CL-00042',
        taxYear: null,
        caseId: null,
        documentId,
        fileName: 'cnic.png',
      }).segments,
    ).toEqual(['clients', 'CL-00042', 'general', 'client-documents', documentId]);
  });

  it('never uses the client name, so a rename leaves paths unchanged', () => {
    // The input has no name field at all: only immutable identifiers.
    const before = buildDocumentStoragePath({
      clientCode: 'CL-00007',
      taxYear: 2025,
      caseId,
      documentId,
      fileName: 'return.pdf',
    });
    const after = buildDocumentStoragePath({
      clientCode: 'CL-00007',
      taxYear: 2025,
      caseId,
      documentId,
      fileName: 'return.pdf',
    });
    expect(after).toEqual(before);
    expect(before.segments.join('/')).not.toMatch(/synthetic|client name/iu);
  });

  it('rejects unstable or unsafe inputs', () => {
    const base = { clientCode: 'CL-00001', taxYear: 2026, caseId, documentId, fileName: 'a.pdf' };
    expect(() => buildDocumentStoragePath({ ...base, clientCode: 'Acme Ltd' })).toThrow(
      StorageLayoutError,
    );
    expect(() => buildDocumentStoragePath({ ...base, documentId: '../x' })).toThrow(
      StorageLayoutError,
    );
    expect(() => buildDocumentStoragePath({ ...base, fileName: '../a.pdf' })).toThrow(
      StorageLayoutError,
    );
    expect(() => buildDocumentStoragePath({ ...base, fileName: 'run.exe' })).toThrow(
      StorageLayoutError,
    );
    expect(() => buildDocumentStoragePath({ ...base, taxYear: null })).toThrow(StorageLayoutError);
  });
});

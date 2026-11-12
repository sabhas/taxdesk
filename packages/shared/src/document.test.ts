import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_LIMITS,
  DocumentReviewRequestSchema,
  UploadCreateRequestSchema,
  contentTypeForFileName,
  documentSatisfiesChecklist,
  formatByteSize,
  unsafeFileNameReason,
} from './document.js';
import { storageAcceptsOperations } from './storage.js';

const CLIENT_ID = '0198a000-0000-7000-8000-000000000001';
const CASE_ID = '0198a000-0000-7000-8000-000000000002';
const ITEM_ID = '0198a000-0000-7000-8000-000000000003';

describe('document filename safety', () => {
  it.each([
    'Bank statement 2025.pdf',
    'scan.JPEG',
    'salary-certificate.docx',
    'ledger.xlsx',
    'export.csv',
    'photo.png',
  ])('accepts %s', (name) => {
    expect(unsafeFileNameReason(name)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['../etc/passwd.pdf', 'path traversal'],
    ['folder/file.pdf', 'separator'],
    ['back\\slash.pdf', 'backslash'],
    ['what?.pdf', 'reserved character'],
    ['tab\tname.pdf', 'control character'],
    [' leading.pdf', 'leading space'],
    ['trailing.pdf.', 'trailing dot'],
    ['.hidden.pdf', 'hidden file'],
    ['~$lock.docx', 'office lock file'],
    ['CON.pdf', 'reserved device name'],
    ['lpt1.csv', 'reserved device name'],
    ['malware.exe', 'not allowlisted'],
    ['noextension', 'no extension'],
    [`${'a'.repeat(DOCUMENT_LIMITS.fileNameMax)}.pdf`, 'too long'],
  ])('rejects %j (%s)', (name) => {
    expect(unsafeFileNameReason(name)).not.toBeNull();
  });

  it('maps extensions to the allowlisted content type', () => {
    expect(contentTypeForFileName('a.PDF')).toBe('application/pdf');
    expect(contentTypeForFileName('a.jpg')).toBe('image/jpeg');
    expect(contentTypeForFileName('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(contentTypeForFileName('a.html')).toBeNull();
  });
});

describe('upload request contract', () => {
  const base = {
    clientId: CLIENT_ID,
    documentType: 'Bank statement',
    fileName: 'statement.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  };

  it('accepts a client-level upload and defaults the links to null', () => {
    const parsed = UploadCreateRequestSchema.parse(base);
    expect(parsed.caseId).toBeNull();
    expect(parsed.checklistItemId).toBeNull();
  });

  it('rejects a checklist link without a case', () => {
    expect(UploadCreateRequestSchema.safeParse({ ...base, checklistItemId: ITEM_ID }).success).toBe(
      false,
    );
    expect(
      UploadCreateRequestSchema.safeParse({ ...base, caseId: CASE_ID, checklistItemId: ITEM_ID })
        .success,
    ).toBe(true);
  });

  it('rejects a content type that does not match the extension or the allowlist', () => {
    expect(UploadCreateRequestSchema.safeParse({ ...base, contentType: 'image/png' }).success).toBe(
      false,
    );
    expect(UploadCreateRequestSchema.safeParse({ ...base, contentType: 'text/html' }).success).toBe(
      false,
    );
  });

  it('rejects empty files and unknown fields', () => {
    expect(UploadCreateRequestSchema.safeParse({ ...base, sizeBytes: 0 }).success).toBe(false);
    expect(UploadCreateRequestSchema.safeParse({ ...base, path: '/x' }).success).toBe(false);
  });

  it('keeps the chunk size a multiple of 320 KiB', () => {
    expect(DOCUMENT_LIMITS.chunkBytes % (320 * 1024)).toBe(0);
  });
});

describe('document review and checklist rules', () => {
  it('requires a note to reject', () => {
    expect(DocumentReviewRequestSchema.safeParse({ decision: 'rejected' }).success).toBe(false);
    expect(
      DocumentReviewRequestSchema.safeParse({ decision: 'rejected', note: 'Unreadable scan' })
        .success,
    ).toBe(true);
    expect(DocumentReviewRequestSchema.safeParse({ decision: 'verified' }).success).toBe(true);
  });

  it('counts only verified, non-deleted documents toward the checklist', () => {
    expect(documentSatisfiesChecklist({ verificationState: 'verified', deletedAt: null })).toBe(
      true,
    );
    for (const state of ['pending', 'rejected', 'missing_provider'] as const) {
      expect(documentSatisfiesChecklist({ verificationState: state, deletedAt: null })).toBe(false);
    }
    expect(
      documentSatisfiesChecklist({
        verificationState: 'verified',
        deletedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('formats byte sizes', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatByteSize(250 * 1024 * 1024)).toBe('250 MB');
  });
});

describe('storage availability', () => {
  it('stops new operations only when storage is missing or needs a reconnect', () => {
    expect(storageAcceptsOperations('healthy')).toBe(true);
    expect(storageAcceptsOperations('unavailable')).toBe(true);
    expect(storageAcceptsOperations('reconnect_required')).toBe(false);
    expect(storageAcceptsOperations('not_connected')).toBe(false);
  });
});

import { z } from 'zod';
import { CaseCodeSchema } from './case.js';
import { ClientCodeSchema } from './client.js';
import { UuidV7Schema } from './id.js';

/**
 * Document contracts (Epic 4, TD-405–TD-410). Documents are stored by a
 * `DocumentStorageProvider`; PostgreSQL keeps provider-neutral metadata only
 * (external item ID, size, content type, verification state, links). File
 * bytes and provider paths never appear in these shapes.
 */

// ---------------------------------------------------------------------------
// Limits, allowlist, and filename safety (TD-405, TD-406)
// ---------------------------------------------------------------------------

export const MIB = 1024 * 1024;

export const DOCUMENT_LIMITS = {
  /** Default maximum upload size; a deployment may lower or raise it via config. */
  defaultMaxUploadBytes: 250 * MIB,
  /** Upload chunk size: 5 MiB, a multiple of OneDrive's 320 KiB requirement. */
  chunkBytes: 5 * MIB,
  fileNameMax: 180,
  documentTypeMax: 80,
  noteMax: 1000,
} as const;

/** Initial allowlist: PDF, JPEG, PNG, DOCX, XLSX, CSV. */
export const DOCUMENT_CONTENT_TYPES = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/csv': ['csv'],
} as const satisfies Record<string, readonly string[]>;

export type DocumentContentType = keyof typeof DOCUMENT_CONTENT_TYPES;

export const DOCUMENT_CONTENT_TYPE_KEYS = Object.keys(DOCUMENT_CONTENT_TYPES) as [
  DocumentContentType,
  ...DocumentContentType[],
];

export const DocumentContentTypeSchema = z.enum(DOCUMENT_CONTENT_TYPE_KEYS, {
  errorMap: () => ({ message: 'Upload a PDF, JPEG, PNG, DOCX, XLSX, or CSV file.' }),
});

/** Comma-separated `accept` attribute for file inputs. */
export const DOCUMENT_ACCEPT_ATTRIBUTE = [
  ...DOCUMENT_CONTENT_TYPE_KEYS,
  ...Object.values(DOCUMENT_CONTENT_TYPES)
    .flat()
    .map((extension) => `.${extension}`),
].join(',');

/** The allowlisted content type for a filename's extension, or `null`. */
export function contentTypeForFileName(fileName: string): DocumentContentType | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  const extension = fileName.slice(dot + 1).toLowerCase();
  for (const type of DOCUMENT_CONTENT_TYPE_KEYS) {
    if ((DOCUMENT_CONTENT_TYPES[type] as readonly string[]).includes(extension)) {
      return type;
    }
  }
  return null;
}

// Windows/OneDrive reserved device names (case-insensitive, with or without extension).
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;
// Characters OneDrive and common filesystems reject, plus control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
const UNSAFE_CHARACTERS = /["*:<>?/\\|\u0000-\u001f\u007f]/u;

/**
 * Why a filename is unsafe, or `null` when it is acceptable. The rules are the
 * same in the browser (early feedback) and on the server (enforcement).
 */
export function unsafeFileNameReason(fileName: string): string | null {
  if (fileName.length === 0 || fileName.trim().length === 0) {
    return 'Enter a file name.';
  }
  if (fileName.length > DOCUMENT_LIMITS.fileNameMax) {
    return `Use a file name of at most ${String(DOCUMENT_LIMITS.fileNameMax)} characters.`;
  }
  if (UNSAFE_CHARACTERS.test(fileName)) {
    return 'The file name contains characters that are not allowed (" * : < > ? / \\ |).';
  }
  if (fileName !== fileName.trim() || fileName.endsWith('.')) {
    return 'The file name cannot start or end with a space, or end with a dot.';
  }
  if (fileName.startsWith('.') || fileName.startsWith('~$')) {
    return 'Hidden and temporary files cannot be uploaded.';
  }
  if (fileName.includes('..')) {
    return 'The file name cannot contain "..".';
  }
  if (RESERVED_NAMES.test(fileName)) {
    return 'The file name is reserved by the operating system.';
  }
  if (contentTypeForFileName(fileName) === null) {
    return 'Upload a PDF, JPEG, PNG, DOCX, XLSX, or CSV file.';
  }
  return null;
}

export const DocumentFileNameSchema = z.string().superRefine((value, ctx) => {
  const reason = unsafeFileNameReason(value);
  if (reason !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason });
  }
});

export const DocumentTypeLabelSchema = z
  .string()
  .trim()
  .min(1, 'Choose a document type.')
  .max(DOCUMENT_LIMITS.documentTypeMax, 'Use a shorter document type.');

// ---------------------------------------------------------------------------
// States (TD-408, TD-409, TD-410)
// ---------------------------------------------------------------------------

/**
 * Verification state. `missing_provider` is set by reconciliation when the
 * stored object can no longer be found; it is cleared back to `pending` when a
 * later run finds the object again. A missing document never satisfies a
 * checklist item.
 */
export const DOCUMENT_VERIFICATION_STATES = [
  'pending',
  'verified',
  'rejected',
  'missing_provider',
] as const;
export const DocumentVerificationStateSchema = z.enum(DOCUMENT_VERIFICATION_STATES);
export type DocumentVerificationState = z.infer<typeof DocumentVerificationStateSchema>;

/** Where the provider object stands at the last check. */
export const DOCUMENT_PROVIDER_STATES = ['present', 'missing', 'moved'] as const;
export const DocumentProviderStateSchema = z.enum(DOCUMENT_PROVIDER_STATES);
export type DocumentProviderState = z.infer<typeof DocumentProviderStateSchema>;

/** Review decisions a user can make; `missing_provider` is set only by reconciliation. */
export const DOCUMENT_REVIEW_DECISIONS = ['verified', 'rejected', 'pending'] as const;
export const DocumentReviewDecisionSchema = z.enum(DOCUMENT_REVIEW_DECISIONS);
export type DocumentReviewDecision = z.infer<typeof DocumentReviewDecisionSchema>;

/** Whether a document counts toward its linked checklist item. */
export function documentSatisfiesChecklist(document: {
  readonly verificationState: DocumentVerificationState;
  readonly deletedAt: string | null;
}): boolean {
  return document.verificationState === 'verified' && document.deletedAt === null;
}

// ---------------------------------------------------------------------------
// Uploads (TD-406)
// ---------------------------------------------------------------------------

export const UPLOAD_STATES = ['active', 'completed', 'cancelled', 'expired', 'failed'] as const;
export const UploadStateSchema = z.enum(UPLOAD_STATES);
export type UploadState = z.infer<typeof UploadStateSchema>;

export const UploadCreateRequestSchema = z
  .object({
    clientId: UuidV7Schema,
    caseId: UuidV7Schema.nullable().default(null),
    checklistItemId: UuidV7Schema.nullable().default(null),
    documentType: DocumentTypeLabelSchema,
    fileName: DocumentFileNameSchema,
    contentType: DocumentContentTypeSchema,
    sizeBytes: z.number().int().positive('The file is empty.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.checklistItemId !== null && value.caseId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checklistItemId'],
        message: 'A checklist item can only be linked through its case.',
      });
    }
    const expected = contentTypeForFileName(value.fileName);
    if (expected !== null && expected !== value.contentType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentType'],
        message: 'The file type does not match the file name extension.',
      });
    }
  });
export type UploadCreateRequest = z.input<typeof UploadCreateRequestSchema>;

export const UploadSessionSchema = z
  .object({
    id: UuidV7Schema,
    documentId: UuidV7Schema,
    state: UploadStateSchema,
    fileName: z.string(),
    sizeBytes: z.number().int().positive(),
    /** Bytes the provider has accepted; the next chunk starts here. */
    nextOffset: z.number().int().nonnegative(),
    chunkBytes: z.number().int().positive(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type UploadSession = z.infer<typeof UploadSessionSchema>;

/** Response to a chunk PUT. `complete` means every byte reached the provider. */
export const UploadChunkResponseSchema = z
  .object({
    nextOffset: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
export type UploadChunkResponse = z.infer<typeof UploadChunkResponseSchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DocumentSchema = z
  .object({
    id: UuidV7Schema,
    clientId: UuidV7Schema,
    clientCode: ClientCodeSchema,
    clientName: z.string(),
    caseId: UuidV7Schema.nullable(),
    caseCode: CaseCodeSchema.nullable(),
    checklistItemId: UuidV7Schema.nullable(),
    checklistItemLabel: z.string().nullable(),
    documentType: z.string(),
    fileName: z.string(),
    contentType: DocumentContentTypeSchema,
    sizeBytes: z.number().int().positive(),
    verificationState: DocumentVerificationStateSchema,
    verificationNote: z.string().nullable(),
    verifiedByName: z.string().nullable(),
    verifiedAt: z.string().datetime().nullable(),
    providerState: DocumentProviderStateSchema,
    lastReconciledAt: z.string().datetime().nullable(),
    uploadedByName: z.string().nullable(),
    uploadedAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
    deletedByName: z.string().nullable(),
    version: z.number().int().positive(),
    permissions: z
      .object({
        open: z.boolean(),
        edit: z.boolean(),
        review: z.boolean(),
        delete: z.boolean(),
        restore: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type Document = z.infer<typeof DocumentSchema>;

export const DOCUMENT_LIST_STATES = ['active', 'deleted', 'all'] as const;
export const DocumentListStateSchema = z.enum(DOCUMENT_LIST_STATES);
export type DocumentListState = z.infer<typeof DocumentListStateSchema>;

export const DocumentListQuerySchema = z
  .object({
    clientId: UuidV7Schema.optional(),
    caseId: UuidV7Schema.optional(),
    checklistItemId: UuidV7Schema.optional(),
    /** Deleted documents are excluded unless asked for. */
    state: DocumentListStateSchema.default('active'),
    verificationState: DocumentVerificationStateSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((value) => value.clientId !== undefined || value.caseId !== undefined, {
    message: 'Choose a client or a case.',
    path: ['clientId'],
  });
export type DocumentListQuery = z.infer<typeof DocumentListQuerySchema>;

export const DocumentListSchema = z
  .object({
    documents: z.array(DocumentSchema),
    nextCursor: z.string().nullable(),
    /** Whether new uploads and opens may run right now (storage healthy). */
    storageAvailable: z.boolean(),
    /** The deployment's configured upload size limit in bytes. */
    maxUploadBytes: z.number().int().positive(),
    permissions: z
      .object({
        upload: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type DocumentList = z.infer<typeof DocumentListSchema>;

/** Metadata edit (`If-Match`). Moving a document to another client is not allowed. */
export const DocumentUpdateRequestSchema = z
  .object({
    documentType: DocumentTypeLabelSchema.optional(),
    checklistItemId: UuidV7Schema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change.' });
export type DocumentUpdateRequest = z.infer<typeof DocumentUpdateRequestSchema>;

export const DocumentReviewRequestSchema = z
  .object({
    decision: DocumentReviewDecisionSchema,
    note: z.string().trim().max(DOCUMENT_LIMITS.noteMax).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'rejected' && (value.note === undefined || value.note.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'Explain why the document is rejected.',
      });
    }
  });
export type DocumentReviewRequest = z.infer<typeof DocumentReviewRequestSchema>;

/** Byte count in a short human form for the UI ("4.2 MB"). */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

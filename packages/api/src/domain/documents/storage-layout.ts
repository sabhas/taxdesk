import { CLIENT_CODE_PATTERN, UuidSchema, unsafeFileNameReason } from '@taxdesk/shared';
import type { StoragePath } from '../../storage/provider.js';

export interface DocumentLocation {
  /** Stable client code (`CL-00001`); never the client's name, which can change. */
  readonly clientCode: string;
  /** The case's tax year, or `null` for a client-level document. */
  readonly taxYear: number | null;
  readonly caseId: string | null;
  readonly documentId: string;
  readonly fileName: string;
}

export class StorageLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLayoutError';
  }
}

/** Folder used for a client-level document's year segment. */
export const CLIENT_LEVEL_YEAR_SEGMENT = 'general';
/** Folder used for a client-level document's case segment. */
export const CLIENT_LEVEL_CASE_SEGMENT = 'client-documents';

/**
 * Stable storage layout (TD-405), relative to the provider's app root:
 *
 *   clients/<client code>/<tax year | general>/<case ID | client-documents>/<document ID>/<file name>
 *
 * Every segment comes from an immutable record field, so renaming a client
 * never moves or breaks a stored object. The path is used only to create the
 * object; afterwards the provider's external item ID is the durable reference.
 */
export function buildDocumentStoragePath(location: DocumentLocation): StoragePath {
  if (!CLIENT_CODE_PATTERN.test(location.clientCode)) {
    throw new StorageLayoutError('The client code is not a stable client code.');
  }
  if (!UuidSchema.safeParse(location.documentId).success) {
    throw new StorageLayoutError('The document ID is not a UUID.');
  }
  if (location.caseId !== null && !UuidSchema.safeParse(location.caseId).success) {
    throw new StorageLayoutError('The case ID is not a UUID.');
  }
  if ((location.caseId === null) !== (location.taxYear === null)) {
    throw new StorageLayoutError('A case document needs its tax year, and only a case document.');
  }
  if (location.taxYear !== null && !Number.isSafeInteger(location.taxYear)) {
    throw new StorageLayoutError('The tax year is not an integer.');
  }
  if (unsafeFileNameReason(location.fileName) !== null) {
    throw new StorageLayoutError('The file name is not safe for storage.');
  }
  return {
    segments: [
      'clients',
      location.clientCode,
      location.taxYear === null ? CLIENT_LEVEL_YEAR_SEGMENT : String(location.taxYear),
      location.caseId ?? CLIENT_LEVEL_CASE_SEGMENT,
      location.documentId,
    ],
    fileName: location.fileName,
  };
}

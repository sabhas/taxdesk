import { CASE_CODE_PATTERN, CLIENT_CODE_PATTERN, unsafeFileNameReason } from '@taxdesk/shared';
import type { StoragePath } from '../../storage/provider.js';

export interface DocumentLocation {
  /** Stable client code (`CL-00001`); never the client's name, which can change. */
  readonly clientCode: string;
  /** The case's tax year, or `null` for a client-level document. */
  readonly taxYear: number | null;
  /** Stable case code (`TC-00042`), or `null` for a client-level document. */
  readonly caseCode: string | null;
  readonly fileName: string;
}

export class StorageLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageLayoutError';
  }
}

/** Folder that holds a client's documents that do not belong to a case. */
export const CLIENT_LEVEL_SEGMENT = 'general';

/**
 * Browsable storage layout (TD-411, ADR 0011), relative to the provider's app
 * root:
 *
 *   clients/<client code>/<tax year>/<case code>/<file name>   case documents
 *   clients/<client code>/general/<file name>                  client-level documents
 *
 * Staff read these folders directly in OneDrive, so every folder is a code or
 * a tax year they recognize. Codes are never changed or reused, and names are
 * left out, so renaming a client never leaves a stale folder. Two files with
 * the same name in one folder are kept apart by the provider, which picks a
 * free name. The path is used only to create the object; afterwards the
 * provider's external item ID is the durable reference.
 */
export function buildDocumentStoragePath(location: DocumentLocation): StoragePath {
  if (!CLIENT_CODE_PATTERN.test(location.clientCode)) {
    throw new StorageLayoutError('The client code is not a stable client code.');
  }
  if (location.caseCode !== null && !CASE_CODE_PATTERN.test(location.caseCode)) {
    throw new StorageLayoutError('The case code is not a stable case code.');
  }
  if ((location.caseCode === null) !== (location.taxYear === null)) {
    throw new StorageLayoutError('A case document needs its tax year, and only a case document.');
  }
  if (
    location.taxYear !== null &&
    (!Number.isSafeInteger(location.taxYear) || location.taxYear < 1)
  ) {
    throw new StorageLayoutError('The tax year is not a positive integer.');
  }
  if (unsafeFileNameReason(location.fileName) !== null) {
    throw new StorageLayoutError('The file name is not safe for storage.');
  }
  const caseSegments =
    location.caseCode === null || location.taxYear === null
      ? [CLIENT_LEVEL_SEGMENT]
      : [String(location.taxYear), location.caseCode];
  return {
    segments: ['clients', location.clientCode, ...caseSegments],
    fileName: location.fileName,
  };
}

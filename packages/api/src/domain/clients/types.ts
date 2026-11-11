import type { ClientType, DuplicateMatchReason } from '@taxdesk/shared';
import type { ProtectedIdentifier } from '../../crypto/identifier-protection.js';

export interface ClientRecord {
  readonly id: string;
  readonly clientCode: string;
  readonly type: ClientType;
  readonly legalName: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly normalizedDisplayName: string;
  readonly cnic: ProtectedIdentifier | null;
  readonly ntn: ProtectedIdentifier | null;
  readonly identifierKeyVersion: number | null;
  readonly notes: string;
  readonly assignedManagerUserId: string | null;
  readonly createdBy: string | null;
  /** Archive timestamp; `null` while the client is active. */
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ClientContactRecord {
  readonly id: string;
  readonly clientId: string;
  readonly position: number;
  readonly name: string;
  readonly relationship: string | null;
  readonly email: string | null;
  readonly emailNormalized: string | null;
  readonly phone: string | null;
  readonly phoneNormalized: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** The editable fields written by an update; `version` and `updatedAt` are set by the repository. */
export interface ClientChanges {
  readonly legalName: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly normalizedDisplayName: string;
  readonly cnic: ProtectedIdentifier | null;
  readonly ntn: ProtectedIdentifier | null;
  readonly identifierKeyVersion: number | null;
  readonly notes: string;
  readonly assignedManagerUserId: string | null;
}

/** Pre-normalized search terms. Each non-null term is OR-ed with the others. */
export interface ClientSearchTerms {
  /** Upper-cased raw term matched against the client code. */
  readonly code: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** Blind indexes the term would have as a CNIC and/or NTN (exact match). */
  readonly identifierIndexes: readonly string[];
}

export interface ClientListCursor {
  readonly sortKey: string;
  readonly id: string;
}

export interface ClientListFilter {
  readonly search: ClientSearchTerms | null;
  readonly type: ClientType | null;
  /** A manager user ID, `unassigned`, or `null` for any. */
  readonly manager: string | null;
  readonly state: 'active' | 'archived' | 'all';
  /** When set, only clients assigned to this user are returned (assignment rule). */
  readonly restrictToManagerUserId: string | null;
  readonly limit: number;
  readonly after: ClientListCursor | null;
}

export interface ClientListPage {
  readonly clients: readonly ClientRecord[];
  readonly hasMore: boolean;
}

export interface DuplicateCandidateQuery {
  readonly cnicIndex: string | null;
  readonly ntnIndex: string | null;
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly normalizedName: string;
  readonly excludeClientId: string | null;
}

export interface DuplicateCandidate {
  readonly client: ClientRecord;
  readonly reasons: readonly DuplicateMatchReason[];
}

/** Sort key shared by both repository implementations. */
export function clientSortKey(displayName: string): string {
  return displayName.toLowerCase();
}

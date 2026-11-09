import { AUDIT_ACTIONS, newUuidV7, type AuditMetadataValue } from '@taxdesk/shared';
import type { AuditRepository } from '../../repositories/ports.js';
import type { AuditEventRecord } from './types.js';

export interface AuditInput {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly requestId: string;
  readonly metadata?: Readonly<Record<string, AuditMetadataValue>>;
}

/**
 * Appends a single audit event. Callers pass only identifiers and non-secret
 * scalar metadata; passwords, session tokens, activation tokens, TOTP secrets,
 * recovery codes, and document contents never reach this function.
 */
export async function appendAuditEvent(
  repository: AuditRepository,
  now: Date,
  input: AuditInput,
): Promise<AuditEventRecord> {
  const event: AuditEventRecord = {
    id: newUuidV7(now.getTime()),
    occurredAt: now.toISOString(),
    actorUserId: input.actorUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    requestId: input.requestId,
    metadata: { ...(input.metadata ?? {}) },
  };
  await repository.append(event);
  return event;
}

export const AUDIT = AUDIT_ACTIONS;

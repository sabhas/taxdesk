import {
  maskAuditMetadata,
  type AuditExplorerList,
  type AuditExplorerQuery,
} from '@taxdesk/shared';
import type { Repositories } from '../../repositories/ports.js';
import { hasPermission } from '../auth/authorization.js';
import { forbidden } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';

export interface AuditExplorerDependencies {
  readonly repositories: Repositories;
}

/**
 * Searchable audit history for administrators (TD-604). Only the audit
 * permission reads it, and metadata is masked before it leaves the service, so
 * a secret or national identifier that reached an event by mistake is still
 * never displayed. Only correlation data (request ID, actor, entity) is shown.
 */
export class AuditExplorerService {
  constructor(private readonly dependencies: AuditExplorerDependencies) {}

  async search(actor: Actor, query: AuditExplorerQuery): Promise<AuditExplorerList> {
    if (!hasPermission(actor, 'audit.read')) {
      throw forbidden();
    }
    const { repositories } = this.dependencies;
    const firm = await repositories.firm.get();
    const page = await repositories.audit.search({
      actorUserId: query.actor ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      timezone: firm?.timezone ?? 'Asia/Karachi',
      action: query.action ?? null,
      entityType: query.entityType ?? null,
      entityId: query.entityId ?? null,
      requestId: query.requestId ?? null,
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
    const names = new Map<string, string | null>();
    const nameOf = async (userId: string | null): Promise<string | null> => {
      if (userId === null) {
        return null;
      }
      if (!names.has(userId)) {
        names.set(userId, (await repositories.users.findById(userId))?.displayName ?? null);
      }
      return names.get(userId) ?? null;
    };
    const events = [];
    for (const event of page.events) {
      events.push({
        id: event.id,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        actorDisplayName: await nameOf(event.actorUserId),
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        requestId: event.requestId,
        metadata: maskAuditMetadata(event.metadata),
      });
    }
    return { events, nextCursor: page.nextCursor };
  }
}

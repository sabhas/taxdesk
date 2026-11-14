import { Hono } from 'hono';
import { AuditExplorerListSchema, AuditExplorerQuerySchema } from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { protect } from '../middleware/auth.js';
import { parseQuery } from './reports.js';

export const auditRoutes = new Hono<AppEnv>();

/**
 * Audit explorer (TD-604): administrators only. Filters by actor, firm-calendar
 * date range, action, entity type and ID, and request ID. Metadata is masked.
 */
auditRoutes.get(
  '/admin/audit-events',
  protect({ access: 'permission', permission: 'audit.read' }),
  async (c) => {
    const query = parseQuery(c, AuditExplorerQuerySchema);
    const list = await c.get('dependencies').auditExplorerService.search(c.get('actor'), query);
    c.header('Cache-Control', 'no-store');
    return c.json(AuditExplorerListSchema.parse(list));
  },
);

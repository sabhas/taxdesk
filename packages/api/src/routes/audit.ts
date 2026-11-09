import { Hono } from 'hono';
import { AuditEventListSchema, UuidV7Schema } from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import { protect } from '../middleware/auth.js';

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get(
  '/admin/audit-events',
  protect({ access: 'permission', permission: 'audit.read' }),
  async (c) => {
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'Limit must be between 1 and 100.', {
        errors: [{ field: 'limit', message: 'Limit must be between 1 and 100.' }],
      });
    }
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && !UuidV7Schema.safeParse(cursor).success) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'The audit cursor is not valid.', {
        errors: [{ field: 'cursor', message: 'The audit cursor is not valid.' }],
      });
    }
    const page = await c.get('dependencies').repositories.audit.list({
      limit,
      cursor: cursor ?? null,
    });
    return c.json(
      AuditEventListSchema.parse({
        events: page.events,
        nextCursor: page.nextCursor,
      }),
    );
  },
);

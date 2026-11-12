import { Hono } from 'hono';
import {
  StorageAuthorizationResponseSchema,
  StorageCallbackRequestSchema,
  StorageCallbackResponseSchema,
  StorageConnectionSchema,
  type StorageConnection,
} from '@taxdesk/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, requireIfMatch, setEtag } from '../transport/request.js';

/**
 * Storage connection routes (TD-402–TD-404). Only `storage.manage`
 * (administrators) connects, checks, and disconnects; staff who read
 * documents may see the connection status so they understand why uploads
 * are unavailable. No response ever carries a token or provider body.
 */
export const storageRoutes = new Hono<AppEnv>();

const manage = () => protect({ access: 'permission', permission: 'storage.manage' });
const read = () =>
  protect({ access: 'any_permission', permissions: ['storage.manage', 'documents.read'] });

function respond(c: Context<AppEnv>, connection: StorageConnection) {
  if (connection.version !== null) {
    setEtag(c, connection.version);
  }
  c.header('Cache-Control', 'no-store');
  return c.json(StorageConnectionSchema.parse(connection));
}

storageRoutes.get('/storage/connection', read(), async (c) => {
  const connection = await c.get('dependencies').storageConnectionService.view(c.get('actor'));
  return respond(c, connection);
});

storageRoutes.post('/storage/connection/authorize', manage(), async (c) => {
  const response = await c.get('dependencies').storageConnectionService.beginAuthorization({
    actorUserId: c.get('actor').userId,
    requestId: c.get('requestId'),
  });
  c.header('Cache-Control', 'no-store');
  return c.json(StorageAuthorizationResponseSchema.parse(response));
});

/**
 * Completes consent. The provider redirects the browser to the web route
 * `/settings/storage/callback` (a cross-site navigation, so the SameSite
 * session cookie is not sent there); that page posts the query values here
 * from the app's own origin, where the session and origin checks apply.
 */
storageRoutes.post('/storage/connection/complete', manage(), async (c) => {
  const request = await parseJsonBody(c, StorageCallbackRequestSchema);
  const result = await c.get('dependencies').storageConnectionService.completeAuthorization({
    actorUserId: c.get('actor').userId,
    requestId: c.get('requestId'),
    request,
  });
  c.header('Cache-Control', 'no-store');
  return c.json(StorageCallbackResponseSchema.parse({ result }));
});

storageRoutes.post('/storage/connection/check', manage(), async (c) => {
  const connection = await c.get('dependencies').storageConnectionService.check({
    actor: c.get('actor'),
    requestId: c.get('requestId'),
  });
  return respond(c, connection);
});

storageRoutes.delete('/storage/connection', manage(), async (c) => {
  const expectedVersion = requireIfMatch(c);
  const connection = await c.get('dependencies').storageConnectionService.disconnect({
    actor: c.get('actor'),
    requestId: c.get('requestId'),
    expectedVersion,
  });
  return respond(c, connection);
});

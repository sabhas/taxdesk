import { Hono, type Context } from 'hono';
import {
  ClientActivityListSchema,
  ClientAssigneeListSchema,
  ClientCreateRequestSchema,
  ClientDuplicateCheckRequestSchema,
  ClientDuplicateCheckResponseSchema,
  ClientListQuerySchema,
  ClientListSchema,
  ClientSchema,
  ClientUpdateRequestSchema,
  UuidSchema,
  UuidV7Schema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, requireIfMatch, setEtag } from '../transport/request.js';

export const clientRoutes = new Hono<AppEnv>();

/**
 * Path IDs are validated before the service runs, so a malformed ID is a 404
 * for everyone and never reaches the assignment rule.
 */
function clientIdParam(c: Context<AppEnv>): string {
  const clientId = c.req.param('clientId') ?? '';
  if (!UuidSchema.safeParse(clientId).success) {
    throw new AuthError(404, 'CLIENT_NOT_FOUND', 'The requested client was not found.');
  }
  return clientId;
}

function validationError(field: string, message: string): AuthError {
  return new AuthError(400, 'VALIDATION_FAILED', message, { errors: [{ field, message }] });
}

clientRoutes.get(
  '/clients',
  protect({ access: 'permission', permission: 'clients.read' }),
  async (c) => {
    const parsed = ClientListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new AuthError(400, 'VALIDATION_FAILED', 'Check the search and filters.', {
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.length === 0 ? 'query' : issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    }
    const list = await c.get('dependencies').clientService.listClients(c.get('actor'), parsed.data);
    c.header('Cache-Control', 'no-store');
    return c.json(ClientListSchema.parse(list));
  },
);

clientRoutes.get(
  '/clients/assignees',
  protect({ access: 'permission', permission: 'clients.read' }),
  async (c) => {
    const assignees = await c.get('dependencies').clientService.listAssignees();
    return c.json(ClientAssigneeListSchema.parse({ assignees }));
  },
);

clientRoutes.post(
  '/clients/duplicate-check',
  protect({ access: 'permission', permission: 'clients.manage' }),
  async (c) => {
    const request = await parseJsonBody(c, ClientDuplicateCheckRequestSchema);
    const result = await c.get('dependencies').clientService.checkDuplicates(request);
    c.header('Cache-Control', 'no-store');
    return c.json(ClientDuplicateCheckResponseSchema.parse(result));
  },
);

clientRoutes.post(
  '/clients',
  protect({ access: 'permission', permission: 'clients.manage' }),
  async (c) => {
    const request = await parseJsonBody(c, ClientCreateRequestSchema);
    const client = await c.get('dependencies').clientService.createClient({
      actor: c.get('actor'),
      request,
      requestId: c.get('requestId'),
    });
    setEtag(c, client.version);
    return c.json(ClientSchema.parse(client), 201);
  },
);

clientRoutes.get(
  '/clients/:clientId',
  protect({ access: 'permission', permission: 'clients.read' }),
  async (c) => {
    const client = await c
      .get('dependencies')
      .clientService.getClient(c.get('actor'), clientIdParam(c));
    setEtag(c, client.version);
    c.header('Cache-Control', 'no-store');
    return c.json(ClientSchema.parse(client));
  },
);

clientRoutes.patch(
  '/clients/:clientId',
  protect({ access: 'permission', permission: 'clients.manage' }),
  async (c) => {
    const clientId = clientIdParam(c);
    const expectedVersion = requireIfMatch(c);
    const request = await parseJsonBody(c, ClientUpdateRequestSchema);
    const client = await c.get('dependencies').clientService.updateClient({
      actor: c.get('actor'),
      clientId,
      request,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, client.version);
    return c.json(ClientSchema.parse(client));
  },
);

for (const [action, archived] of [
  ['archive', true],
  ['restore', false],
] as const) {
  clientRoutes.post(
    `/clients/:clientId/${action}`,
    protect({ access: 'permission', permission: 'clients.manage' }),
    async (c) => {
      const clientId = clientIdParam(c);
      const expectedVersion = requireIfMatch(c);
      const client = await c.get('dependencies').clientService.setArchived({
        actor: c.get('actor'),
        clientId,
        archived,
        expectedVersion,
        requestId: c.get('requestId'),
      });
      setEtag(c, client.version);
      return c.json(ClientSchema.parse(client));
    },
  );
}

clientRoutes.get(
  '/clients/:clientId/activity',
  protect({ access: 'permission', permission: 'clients.read' }),
  async (c) => {
    const clientId = clientIdParam(c);
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw validationError('limit', 'Limit must be between 1 and 100.');
    }
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && !UuidV7Schema.safeParse(cursor).success) {
      throw validationError('cursor', 'The activity cursor is not valid.');
    }
    const activity = await c.get('dependencies').clientService.listActivity({
      actor: c.get('actor'),
      clientId,
      limit,
      cursor: cursor ?? null,
    });
    c.header('Cache-Control', 'no-store');
    return c.json(ClientActivityListSchema.parse(activity));
  },
);

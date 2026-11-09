import { Hono } from 'hono';
import {
  ActivationLinkSchema,
  InviteUserRequestSchema,
  InviteUserResponseSchema,
  UserListSchema,
  UserSummarySchema,
  UserUpdateRequestSchema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, publicBaseUrl, requireIfMatch, setEtag } from '../transport/request.js';

export const userRoutes = new Hono<AppEnv>();

userRoutes.get(
  '/users/:userId',
  protect({ access: 'self_or_permission', permission: 'users.read', param: 'userId' }),
  async (c) => {
    const userId = c.req.param('userId');
    const user = await c.get('dependencies').userService.getUser(userId);
    return c.json(UserSummarySchema.parse(user));
  },
);

userRoutes.get(
  '/admin/users',
  protect({ access: 'permission', permission: 'users.manage' }),
  async (c) => {
    const users = await c.get('dependencies').userService.listUsers();
    return c.json(UserListSchema.parse({ users }));
  },
);

userRoutes.post(
  '/admin/users/invitations',
  protect({ access: 'permission', permission: 'users.manage' }),
  async (c) => {
    const invitation = await parseJsonBody(c, InviteUserRequestSchema);
    const result = await c.get('dependencies').userService.inviteUser({
      actor: c.get('actor'),
      invitation,
      requestId: c.get('requestId'),
      baseUrl: publicBaseUrl(c),
    });
    return c.json(InviteUserResponseSchema.parse(result));
  },
);

userRoutes.patch(
  '/admin/users/:userId',
  protect({ access: 'permission', permission: 'users.manage' }),
  async (c) => {
    const update = await parseJsonBody(c, UserUpdateRequestSchema);
    const expectedVersion = requireIfMatch(c);
    const user = await c.get('dependencies').userService.updateUser({
      actor: c.get('actor'),
      userId: c.req.param('userId'),
      update,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, user.version);
    return c.json(UserSummarySchema.parse(user));
  },
);

userRoutes.post(
  '/admin/users/:userId/reset-link',
  protect({ access: 'permission', permission: 'users.manage' }),
  async (c) => {
    const link = await c.get('dependencies').userService.issuePasswordResetLink({
      actor: c.get('actor'),
      userId: c.req.param('userId'),
      requestId: c.get('requestId'),
      baseUrl: publicBaseUrl(c),
    });
    return c.json(ActivationLinkSchema.parse(link));
  },
);

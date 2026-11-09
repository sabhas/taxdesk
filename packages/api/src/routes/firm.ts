import { Hono } from 'hono';
import { FirmSettingsSchema, FirmSettingsUpdateSchema } from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { protect } from '../middleware/auth.js';
import { parseJsonBody, requireIfMatch, setEtag } from '../transport/request.js';

export const firmRoutes = new Hono<AppEnv>();

firmRoutes.get(
  '/firm/settings',
  protect({ access: 'permission', permission: 'firm.settings.read' }),
  async (c) => {
    const settings = await c.get('dependencies').firmService.getSettings();
    setEtag(c, settings.version);
    return c.json(FirmSettingsSchema.parse(settings));
  },
);

firmRoutes.patch(
  '/firm/settings',
  protect({ access: 'permission', permission: 'firm.settings.manage' }),
  async (c) => {
    const update = await parseJsonBody(c, FirmSettingsUpdateSchema);
    const expectedVersion = requireIfMatch(c);
    const settings = await c.get('dependencies').firmService.updateSettings({
      actor: c.get('actor'),
      update,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, settings.version);
    return c.json(FirmSettingsSchema.parse(settings));
  },
);

import { Hono, type Context } from 'hono';
import { FIRM_LOGO_LIMITS, FirmSettingsSchema, FirmSettingsUpdateSchema } from '@taxdesk/shared';
import { logoValidationError } from '../domain/auth/firm-service.js';
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

// ---------------------------------------------------------------------------
// Firm logo (TD-512)
// ---------------------------------------------------------------------------

/** Reads the raw image body, refusing anything over the limit before and after reading. */
async function logoBody(c: Context<AppEnv>): Promise<Uint8Array> {
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > FIRM_LOGO_LIMITS.maxBytes) {
    throw logoValidationError('too_large');
  }
  // A chunked request carries no Content-Length, so bound the bytes actually read too.
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > FIRM_LOGO_LIMITS.maxBytes) {
    throw logoValidationError('too_large');
  }
  return bytes;
}

firmRoutes.get(
  '/firm/logo',
  protect({ access: 'permission', permission: 'firm.settings.read' }),
  async (c) => {
    const logo = await c.get('dependencies').firmService.getLogo();
    c.header('Content-Type', logo.contentType);
    c.header('Content-Length', String(logo.bytes.length));
    // The URL carries the digest, so a cached copy is never stale; it stays private.
    c.header('Cache-Control', 'private, max-age=86400');
    c.header('ETag', `"${logo.sha256}"`);
    c.header('Content-Security-Policy', 'sandbox');
    return c.body(logo.bytes.slice().buffer, 200);
  },
);

firmRoutes.put(
  '/firm/logo',
  protect({ access: 'permission', permission: 'firm.settings.manage' }),
  async (c) => {
    const expectedVersion = requireIfMatch(c);
    const bytes = await logoBody(c);
    const settings = await c.get('dependencies').firmService.setLogo({
      actor: c.get('actor'),
      bytes,
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, settings.version);
    return c.json(FirmSettingsSchema.parse(settings));
  },
);

firmRoutes.delete(
  '/firm/logo',
  protect({ access: 'permission', permission: 'firm.settings.manage' }),
  async (c) => {
    const expectedVersion = requireIfMatch(c);
    const settings = await c.get('dependencies').firmService.removeLogo({
      actor: c.get('actor'),
      expectedVersion,
      requestId: c.get('requestId'),
    });
    setEtag(c, settings.version);
    return c.json(FirmSettingsSchema.parse(settings));
  },
);

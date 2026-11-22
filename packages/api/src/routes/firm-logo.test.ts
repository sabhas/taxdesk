/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- route tests navigate untyped JSON response bodies */
import { describe, expect, it } from 'vitest';
import type { RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import {
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
} from '../testing/harness.js';
import {
  GIF_IMAGE,
  JPEG_LOGO,
  PNG_LOGO,
  oversizedPng,
  tooLargePng,
  truncatedPng,
} from '../testing/logo-fixtures.js';

const PASSWORD = 'correct horse battery staple';
const ROLES: readonly RoleKey[] = [
  'administrator',
  'manager',
  'consultant',
  'billing',
  'read_only',
];
let counter = 0;

interface Called {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  data: Record<string, any>;
}

interface CallOptions {
  as: RoleKey;
  method?: string;
  image?: Uint8Array;
  contentType?: string;
  ifMatch?: number | null;
}

async function world(): Promise<{
  harness: TestHarness;
  call: (path: string, options: CallOptions) => Promise<Called>;
  version: () => Promise<number>;
}> {
  const harness = createTestHarness({ now: new Date('2026-06-01T04:00:00.000Z') });
  await seedFirm(harness);
  const app = createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
  const cookies = {} as Record<RoleKey, string>;
  for (const role of ROLES) {
    const { user } = await seedUser(harness, {
      username: `logo-${role.replace('_', '-')}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    cookies[role] = (await sessionCookieFor(harness, user)).cookie;
  }
  const call = async (path: string, options: CallOptions): Promise<Called> => {
    harness.advance(1_000);
    const headers: Record<string, string> = {
      'X-Request-Id': `logo-${String(++counter)}`,
      Cookie: cookies[options.as],
    };
    if (options.image !== undefined) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
    }
    if (options.ifMatch !== undefined && options.ifMatch !== null) {
      headers['If-Match'] = `"${String(options.ifMatch)}"`;
    }
    const response = await app.request(
      path,
      {
        method: options.method ?? 'GET',
        headers,
        ...(options.image === undefined ? {} : { body: options.image }),
      },
      { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    let data: Record<string, any> = {};
    if ((response.headers.get('Content-Type') ?? '').includes('json') && bytes.length > 0) {
      data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>;
    }
    return { status: response.status, headers: response.headers, bytes, data };
  };
  const version = async (): Promise<number> =>
    (await call('/api/v1/firm/settings', { as: 'administrator' })).data['version'] as number;
  return { harness, call, version };
}

async function upload(
  w: Awaited<ReturnType<typeof world>>,
  image: Uint8Array,
  options: Partial<CallOptions> = {},
): Promise<Called> {
  return await w.call('/api/v1/firm/logo', {
    as: 'administrator',
    method: 'PUT',
    image,
    ifMatch: await w.version(),
    ...options,
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('firm logo (TD-512)', () => {
  it('starts without a logo', async () => {
    const w = await world();
    const settings = await w.call('/api/v1/firm/settings', { as: 'read_only' });
    expect(settings.data['logo']).toBeNull();
    const image = await w.call('/api/v1/firm/logo', { as: 'administrator' });
    expect(image.status).toBe(404);
    expect(image.data['code']).toBe('FIRM_LOGO_NOT_FOUND');
  });

  it('stores an uploaded PNG, describes it in the settings, and serves it to every role', async () => {
    const w = await world();
    const before = await w.version();
    const result = await upload(w, PNG_LOGO, { contentType: 'image/png' });
    expect(result.status).toBe(200);
    expect(result.headers.get('ETag')).toBe(`"${String(before + 1)}"`);
    expect(result.data['version']).toBe(before + 1);
    expect(result.data['logo']).toEqual({
      contentType: 'image/png',
      byteSize: PNG_LOGO.length,
      sha256: await sha256Hex(PNG_LOGO),
      updatedAt: expect.any(String),
    });
    for (const role of ROLES) {
      const image = await w.call('/api/v1/firm/logo', { as: role });
      expect(image.status, role).toBe(200);
      expect(image.headers.get('Content-Type')).toBe('image/png');
      expect(image.headers.get('Cache-Control')).toContain('private');
      expect(Array.from(image.bytes)).toEqual(Array.from(PNG_LOGO));
    }
  });

  it('takes the type from the bytes, not the declared content type', async () => {
    const w = await world();
    const jpeg = await upload(w, JPEG_LOGO, { contentType: 'image/png' });
    expect(jpeg.status).toBe(200);
    expect(jpeg.data['logo'].contentType).toBe('image/jpeg');
    const gif = await upload(w, GIF_IMAGE, { contentType: 'image/png' });
    expect(gif.status).toBe(400);
    expect(gif.data['errors'][0]).toEqual({ field: 'logo', message: 'Use a PNG or JPEG image.' });
  });

  it('rejects empty, oversized, huge, and corrupt images with a field error', async () => {
    const w = await world();
    for (const [image, message] of [
      [new Uint8Array(), 'Choose a logo image'],
      [tooLargePng(), '512 KiB'],
      [oversizedPng(), '2000 pixels'],
      [truncatedPng(), 'could not be read'],
    ] as const) {
      const result = await upload(w, image);
      expect(result.status, message).toBe(400);
      expect(result.data['code']).toBe('VALIDATION_FAILED');
      expect(result.data['errors'][0].field).toBe('logo');
      expect(result.data['detail']).toContain(message);
    }
    const settings = await w.call('/api/v1/firm/settings', { as: 'administrator' });
    expect(settings.data['logo']).toBeNull();
    expect(
      w.harness.state.auditEvents.filter((event) => event.action.startsWith('firm.logo')),
    ).toHaveLength(0);
  });

  it('lets only administrators upload or remove the logo', async () => {
    const w = await world();
    for (const role of ROLES.filter((candidate) => candidate !== 'administrator')) {
      const put = await upload(w, PNG_LOGO, { as: role });
      expect(put.status, role).toBe(403);
      const removed = await w.call('/api/v1/firm/logo', {
        as: role,
        method: 'DELETE',
        ifMatch: await w.version(),
      });
      expect(removed.status, role).toBe(403);
    }
    expect(w.harness.state.firmLogo).toBeNull();
  });

  it('requires the current settings version', async () => {
    const w = await world();
    const missing = await upload(w, PNG_LOGO, { ifMatch: null });
    expect(missing.status).toBe(428);
    const stale = await upload(w, PNG_LOGO, { ifMatch: (await w.version()) + 99 });
    expect(stale.status).toBe(412);
    const stored = await upload(w, PNG_LOGO);
    const staleRemove = await w.call('/api/v1/firm/logo', {
      as: 'administrator',
      method: 'DELETE',
      ifMatch: (stored.data['version'] as number) - 1,
    });
    expect(staleRemove.status).toBe(412);
    expect(w.harness.state.firmLogo).not.toBeNull();
  });

  it('audits each change with type, size, and digest but never the image', async () => {
    const w = await world();
    await upload(w, PNG_LOGO);
    await upload(w, JPEG_LOGO);
    const removed = await w.call('/api/v1/firm/logo', {
      as: 'administrator',
      method: 'DELETE',
      ifMatch: await w.version(),
    });
    expect(removed.status).toBe(200);
    expect(removed.data['logo']).toBeNull();
    expect((await w.call('/api/v1/firm/logo', { as: 'administrator' })).status).toBe(404);

    const events = w.harness.state.auditEvents.filter((event) =>
      event.action.startsWith('firm.logo'),
    );
    expect(events.map((event) => event.action)).toEqual([
      'firm.logo_updated',
      'firm.logo_updated',
      'firm.logo_removed',
    ]);
    const pngSha = await sha256Hex(PNG_LOGO);
    const jpegSha = await sha256Hex(JPEG_LOGO);
    expect(events[0]?.metadata).toMatchObject({
      contentType: 'image/png',
      byteSize: PNG_LOGO.length,
      imageSha256: pngSha,
      replaced: false,
    });
    expect(events[1]?.metadata).toMatchObject({
      contentType: 'image/jpeg',
      imageSha256: jpegSha,
      replaced: true,
      previousImageSha256: pngSha,
    });
    expect(events[2]?.metadata).toMatchObject({
      previousImageSha256: jpegSha,
      previousImageFingerprint: jpegSha.slice(0, 12),
    });
    // The explorer masks the long digest but shows the short fingerprint.
    const explorer = await w.call('/api/v1/admin/audit-events?action=firm.logo_updated', {
      as: 'administrator',
    });
    const shown = explorer.data['events'][1].metadata;
    expect(shown.imageFingerprint).toBe(pngSha.slice(0, 12));
    expect(shown.imageSha256).toBe('[masked]');
    expect(events.every((event) => event.requestId.startsWith('logo-'))).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(btoa(String.fromCharCode(...PNG_LOGO)));

    const again = await w.call('/api/v1/firm/logo', {
      as: 'administrator',
      method: 'DELETE',
      ifMatch: await w.version(),
    });
    expect(again.status).toBe(404);
  });
});

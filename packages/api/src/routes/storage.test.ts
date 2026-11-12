import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { RoleKey } from '@taxdesk/shared';
import { createApp } from '../app.js';
import type { AppEnv } from '../types.js';
import { createSecretCipher } from '../crypto/cipher.js';
import { createTokenHasher } from '../crypto/token.js';
import { decryptCredentials } from '../domain/storage/credential-vault.js';
import { StorageConnectionService } from '../domain/storage/storage-connection-service.js';
import { createFakeStorageProvider } from '../storage/fake-provider.js';
import { StorageProviderError, type ProviderCredentials } from '../storage/provider.js';
import {
  TEST_STORAGE_KEY,
  connectStorage,
  createTestHarness,
  seedFirm,
  seedUser,
  sessionCookieFor,
  type TestHarness,
  type TestHarnessOptions,
} from '../testing/harness.js';
import type { UserRecord } from '../domain/auth/types.js';

let counter = 0;
const PASSWORD = 'correct horse battery staple';
const HOUR = 60 * 60 * 1000;

type Actor = RoleKey | 'administrator2';

interface Called {
  status: number;
  etag: string | null;
  text: string;
  data: Record<string, any>;
}

interface World {
  harness: TestHarness;
  app: Hono<AppEnv>;
  users: Record<Actor, UserRecord>;
  /** Every response body, for secret-leak assertions. */
  bodies: string[];
  call: (
    path: string,
    options: { as: Actor; method?: string; ifMatch?: string | number; body?: unknown },
  ) => Promise<Called>;
}

async function world(options: TestHarnessOptions = {}): Promise<World> {
  const harness = createTestHarness({ now: new Date('2026-06-01T04:00:00.000Z'), ...options });
  await seedFirm(harness);
  const app = createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
  const users = {} as Record<Actor, UserRecord>;
  const people: [Actor, RoleKey][] = [
    ['administrator', 'administrator'],
    ['administrator2', 'administrator'],
    ['manager', 'manager'],
    ['consultant', 'consultant'],
    ['billing', 'billing'],
    ['read_only', 'read_only'],
  ];
  for (const [name, role] of people) {
    const { user } = await seedUser(harness, {
      username: `staff-${name.replace('_', '-')}`,
      displayName: `Staff ${name}`,
      password: PASSWORD,
      role,
      mfaEnrolled: true,
    });
    users[name] = user;
  }
  const bodies: string[] = [];
  const call: World['call'] = async (path, callOptions) => {
    harness.advance(1_000);
    // A fresh session per call: tests advance the clock past the idle timeout.
    const { cookie } = await sessionCookieFor(harness, users[callOptions.as]);
    const headers: Record<string, string> = {
      'X-Request-Id': `storage-${String(++counter)}`,
      Cookie: cookie,
    };
    if (callOptions.ifMatch !== undefined) {
      headers['If-Match'] =
        typeof callOptions.ifMatch === 'number'
          ? `"${String(callOptions.ifMatch)}"`
          : callOptions.ifMatch;
    }
    if (callOptions.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await app.request(
      path,
      {
        method: callOptions.method ?? 'GET',
        headers,
        ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
      },
      { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
    );
    const text = await response.text();
    bodies.push(text);
    let data: Record<string, any> = {};
    try {
      data = text.length === 0 ? {} : (JSON.parse(text) as Record<string, any>);
    } catch {
      data = {};
    }
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      text,
      data,
    };
  };
  return { harness, app, users, bodies, call };
}

async function authorize(w: World, as: Actor = 'administrator'): Promise<string> {
  const response = await w.call('/api/v1/storage/connection/authorize', { as, method: 'POST' });
  expect(response.status).toBe(200);
  const state = new URL(response.data['authorizationUrl'] as string).searchParams.get('state');
  expect(state).not.toBeNull();
  return state ?? '';
}

async function callback(
  w: World,
  query: Record<string, string>,
  as: Actor = 'administrator',
): Promise<Called> {
  return await w.call('/api/v1/storage/connection/complete', {
    as,
    method: 'POST',
    body: query,
  });
}

async function connect(w: World, as: Actor = 'administrator'): Promise<void> {
  const state = await authorize(w, as);
  const response = await callback(w, { code: w.harness.storage.validCode, state }, as);
  expect(response.status).toBe(200);
  expect(response.data['result']).toBe('connected');
}

async function storedCredentials(w: World): Promise<ProviderCredentials> {
  const record = w.harness.state.storageConnection;
  if (record?.tokenCiphertext == null || record.tokenKeyVersion === null) {
    throw new Error('No stored credentials.');
  }
  return await decryptCredentials(
    createSecretCipher(TEST_STORAGE_KEY, 1, 'storage token encryption key'),
    record.tokenCiphertext,
    record.tokenKeyVersion,
  );
}

function actions(w: World): string[] {
  return w.harness.state.auditEvents
    .map((event) => event.action)
    .filter((action) => action.startsWith('storage.'));
}

describe('storage connection access', () => {
  it('limits consent, check, and disconnect to administrators', async () => {
    const w = await world();
    for (const role of ['manager', 'consultant', 'billing', 'read_only'] as const) {
      const authorizeResponse = await w.call('/api/v1/storage/connection/authorize', {
        as: role,
        method: 'POST',
      });
      expect(authorizeResponse.status, role).toBe(403);
      expect((await callback(w, { code: 'x', state: 'y' }, role)).status, role).toBe(403);
      expect(
        (await w.call('/api/v1/storage/connection/check', { as: role, method: 'POST' })).status,
        role,
      ).toBe(403);
      expect(
        (await w.call('/api/v1/storage/connection', { as: role, method: 'DELETE', ifMatch: 1 }))
          .status,
        role,
      ).toBe(403);
    }
  });

  it('shows status to document readers without account details', async () => {
    const w = await world();
    await connect(w);
    const admin = await w.call('/api/v1/storage/connection', { as: 'administrator' });
    expect(admin.status).toBe(200);
    expect(admin.data).toMatchObject({
      status: 'healthy',
      providerType: 'fake',
      accountLabel: 'Fake storage account',
      connectedByName: 'Staff administrator',
      configured: true,
      permissions: { manage: true },
    });
    expect(admin.etag).toBe(`"${String(admin.data['version'])}"`);

    for (const role of ['manager', 'consultant', 'read_only'] as const) {
      const response = await w.call('/api/v1/storage/connection', { as: role });
      expect(response.status, role).toBe(200);
      expect(response.data, role).toMatchObject({
        status: 'healthy',
        accountLabel: null,
        connectedByName: null,
        permissions: { manage: false },
      });
    }
    // Billing holds neither storage.manage nor documents.read.
    expect((await w.call('/api/v1/storage/connection', { as: 'billing' })).status).toBe(403);
  });

  it('reports a never-connected deployment', async () => {
    const w = await world();
    const response = await w.call('/api/v1/storage/connection', { as: 'administrator' });
    expect(response.status).toBe(200);
    expect(response.etag).toBeNull();
    expect(response.data).toMatchObject({
      id: null,
      status: 'not_connected',
      healthReason: null,
      version: null,
      configured: true,
    });
  });
});

describe('administrator consent (TD-403)', () => {
  it('connects, encrypts the tokens with a key version, and audits', async () => {
    const w = await world();
    await connect(w);
    const record = w.harness.state.storageConnection;
    expect(record).toMatchObject({
      status: 'healthy',
      providerType: 'fake',
      tokenKeyVersion: 1,
      externalRootFolderId: 'fake-root',
      externalDriveId: 'fake-drive',
      connectedBy: w.users.administrator.id,
    });
    const credentials = await storedCredentials(w);
    expect(record?.tokenCiphertext).not.toContain(credentials.accessToken);
    expect(record?.tokenCiphertext).not.toContain(credentials.refreshToken);
    expect(record?.accessTokenExpiresAt).toBe(credentials.accessTokenExpiresAt);
    expect(actions(w)).toEqual(['storage.connection_started', 'storage.connected']);
    // The state row keeps only a digest and the encrypted verifier.
    const [stateRow] = [...w.harness.state.storageOAuthStates.values()];
    expect(stateRow?.consumedAt).not.toBeNull();
    expect(stateRow?.stateHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('sends a PKCE S256 challenge and the configured redirect URI', async () => {
    const w = await world();
    const response = await w.call('/api/v1/storage/connection/authorize', {
      as: 'administrator',
      method: 'POST',
    });
    const url = new URL(response.data['authorizationUrl'] as string);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://taxdesk.test/settings/storage/callback',
    );
    expect(response.data['expiresAt']).toBe(
      new Date(w.harness.now().getTime() + 10 * 60_000).toISOString(),
    );
  });

  it('rejects unknown, replayed, expired, and other-administrator states', async () => {
    const w = await world();
    const code = w.harness.storage.validCode;

    expect((await callback(w, { code, state: 'not-a-real-state' })).data['result']).toBe(
      'invalid_state',
    );
    expect((await callback(w, { code })).data['result']).toBe('invalid_state');

    const foreign = await authorize(w, 'administrator2');
    expect((await callback(w, { code, state: foreign })).data['result']).toBe('invalid_state');

    const state = await authorize(w);
    expect((await callback(w, { code, state })).data['result']).toBe('connected');
    expect((await callback(w, { code, state })).data['result']).toBe('invalid_state');

    const late = await authorize(w);
    w.harness.advance(11 * 60_000);
    expect((await callback(w, { code, state: late })).data['result']).toBe('expired');
    expect(
      w.harness.state.auditEvents
        .filter((event) => event.action === 'storage.connection_failed')
        .map((event) => event.metadata['reason']),
    ).toEqual(['invalid_state', 'invalid_state', 'invalid_state', 'invalid_state', 'expired']);
  });

  it('maps a provider error or a rejected code without echoing provider text', async () => {
    const w = await world();
    const denied = await authorize(w);
    const deniedResponse = await callback(w, {
      state: denied,
      error: 'access_denied',
      error_description: 'The user said <script>no</script>',
    });
    expect(deniedResponse.data['result']).toBe('denied');

    const other = await authorize(w);
    expect(
      (await callback(w, { state: other, error: 'server_error', error_description: 'boom' })).data[
        'result'
      ],
    ).toBe('failed');

    const bad = await authorize(w);
    expect((await callback(w, { state: bad, code: 'wrong-code' })).data['result']).toBe('failed');
    const serialized = JSON.stringify(w.harness.state.auditEvents);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('boom');
    expect(w.harness.state.storageConnection).toBeNull();
  });

  it('audits a reconnect separately from a first connection', async () => {
    const w = await world();
    await connect(w);
    w.harness.storage.revokeConsent();
    await w.call('/api/v1/storage/connection/check', { as: 'administrator', method: 'POST' });
    await connect(w);
    expect(actions(w)).toEqual([
      'storage.connection_started',
      'storage.connected',
      'storage.health_changed',
      'storage.connection_started',
      'storage.reconnected',
    ]);
    expect(w.harness.state.storageConnection?.status).toBe('healthy');
  });

  it('rejects a malformed completion body', async () => {
    const w = await world();
    const response = await w.call('/api/v1/storage/connection/complete', {
      as: 'administrator',
      method: 'POST',
      body: { state: 'x', unexpected: true },
    });
    expect(response.status).toBe(400);
    expect(response.data['code']).toBe('VALIDATION_FAILED');
  });

  it('survives two first-time completions racing to create the connection', async () => {
    const w = await world();
    const repository = w.harness.repositories.storageConnections as {
      create: (typeof w.harness.repositories.storageConnections)['create'];
    };
    const original = repository.create.bind(repository);
    let raced = false;
    repository.create = async (record) => {
      if (!raced) {
        raced = true;
        // A concurrent completion inserts the singleton row first; this insert
        // then hits the unique index.
        await original({ ...record, id: '01890000-0000-7000-8000-000000000001' });
        throw new Error('duplicate key value violates unique constraint');
      }
      await original(record);
    };
    await connect(w);
    expect(w.harness.state.storageConnection).toMatchObject({
      id: '01890000-0000-7000-8000-000000000001',
      status: 'healthy',
      connectedBy: w.users.administrator.id,
    });
    expect(actions(w).at(-1)).toBe('storage.reconnected');
  });

  it('connects through the shared test helper', async () => {
    const w = await world();
    await connectStorage(w.harness, w.users.administrator);
    expect(w.harness.state.storageConnection?.status).toBe('healthy');
  });
});

describe('disconnect (TD-403)', () => {
  it('requires If-Match, rejects a stale version, wipes tokens, and audits', async () => {
    const w = await world();
    await connect(w);
    const current = await w.call('/api/v1/storage/connection', { as: 'administrator' });
    const version = current.data['version'] as number;

    const missing = await w.call('/api/v1/storage/connection', {
      as: 'administrator',
      method: 'DELETE',
    });
    expect(missing.status).toBe(428);
    const stale = await w.call('/api/v1/storage/connection', {
      as: 'administrator',
      method: 'DELETE',
      ifMatch: version + 5,
    });
    expect(stale.status).toBe(412);

    const done = await w.call('/api/v1/storage/connection', {
      as: 'administrator',
      method: 'DELETE',
      ifMatch: version,
    });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ status: 'not_connected', connectedAt: null });
    expect(w.harness.state.storageConnection).toMatchObject({
      status: 'not_connected',
      tokenCiphertext: null,
      tokenKeyVersion: null,
      disconnectedBy: w.users.administrator.id,
    });
    expect(actions(w).at(-1)).toBe('storage.disconnected');

    const again = await w.call('/api/v1/storage/connection', {
      as: 'administrator',
      method: 'DELETE',
      ifMatch: done.data['version'] as number,
    });
    expect(again.status).toBe(409);

    // Operations stop until someone connects again.
    await expect(
      w.harness.dependencies.storageConnectionService.run(() => Promise.resolve(1)),
    ).rejects.toMatchObject({ code: 'STORAGE_NOT_CONNECTED', status: 503 });
    await connect(w);
    expect(actions(w).at(-1)).toBe('storage.connected');
  });
});

describe('health and refresh (TD-404)', () => {
  it('checks health and records the check time', async () => {
    const w = await world();
    await connect(w);
    const response = await w.call('/api/v1/storage/connection/check', {
      as: 'administrator',
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ status: 'healthy', healthReason: null });
    expect(response.data['lastCheckedAt']).toBe(w.harness.now().toISOString());
    expect(actions(w)).not.toContain('storage.health_changed');
  });

  it('refreshes an expired token once and persists the rotated refresh token', async () => {
    const w = await world();
    await connect(w);
    const before = await storedCredentials(w);
    w.harness.advance(2 * HOUR);
    const gateway = w.harness.dependencies.storageConnectionService;
    const seen = await Promise.all([
      gateway.run(({ credentials }) => Promise.resolve(credentials.accessToken)),
      gateway.run(({ credentials }) => Promise.resolve(credentials.accessToken)),
      gateway.run(({ credentials }) => Promise.resolve(credentials.accessToken)),
    ]);
    expect(w.harness.storage.calls['refreshCredentials']).toBe(1);
    const after = await storedCredentials(w);
    expect(new Set(seen)).toEqual(new Set([after.accessToken]));
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(w.harness.state.storageConnection?.lastRefreshedAt).toBe(w.harness.now().toISOString());

    // The old refresh token is no longer accepted by the provider; the new one is.
    w.harness.advance(2 * HOUR);
    await gateway.run(() => Promise.resolve(null));
    expect(w.harness.storage.calls['refreshCredentials']).toBe(2);
  });

  it('refreshes and retries once when the provider rejects the access token', async () => {
    const w = await world();
    await connect(w);
    w.harness.storage.expireAccessTokens();
    const gateway = w.harness.dependencies.storageConnectionService;
    const result = await gateway.run(async ({ provider, credentials }) => {
      return (await provider.checkHealth(credentials)).kind === 'healthy'
        ? 'ok'
        : await Promise.reject(new StorageProviderError('unauthorized', 'rejected'));
    });
    expect(result).toBe('ok');
    expect(w.harness.storage.calls['refreshCredentials']).toBe(1);
  });

  it('marks revoked consent as reconnect-required and stops operations', async () => {
    const w = await world();
    await connect(w);
    w.harness.storage.revokeConsent();
    w.harness.advance(2 * HOUR);
    const gateway = w.harness.dependencies.storageConnectionService;
    await expect(
      gateway.run(() => Promise.resolve(1), {
        requestId: 'doc-1',
        actorUserId: w.users.consultant.id,
      }),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_RECONNECT_REQUIRED' });
    expect(w.harness.state.storageConnection).toMatchObject({
      status: 'reconnect_required',
      healthReason: 'refresh_failed',
    });
    const event = w.harness.state.auditEvents.at(-1);
    expect(event).toMatchObject({
      action: 'storage.health_changed',
      requestId: 'doc-1',
      actorUserId: w.users.consultant.id,
      metadata: { from: 'healthy', to: 'reconnect_required', reason: 'refresh_failed' },
    });

    // Further operations stop without calling the provider.
    const callsBefore = { ...w.harness.storage.calls };
    let ran = false;
    await expect(
      gateway.run(() => {
        ran = true;
        return Promise.resolve(1);
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_RECONNECT_REQUIRED' });
    await expect(gateway.runWithoutCredentials(() => Promise.resolve(1))).rejects.toMatchObject({
      code: 'STORAGE_RECONNECT_REQUIRED',
    });
    expect(ran).toBe(false);
    expect(w.harness.storage.calls).toEqual(callsBefore);

    const status = await w.call('/api/v1/storage/connection', { as: 'consultant' });
    expect(status.data).toMatchObject({ status: 'reconnect_required' });

    // Reconnecting restores operations.
    await connect(w);
    await expect(gateway.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('marks revoked consent unhealthy from a health check', async () => {
    const w = await world();
    await connect(w);
    w.harness.storage.revokeConsent();
    const response = await w.call('/api/v1/storage/connection/check', {
      as: 'administrator',
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      status: 'reconnect_required',
      healthReason: 'consent_revoked',
    });
  });

  it('marks transient failures unavailable and recovers on the next success', async () => {
    const w = await world();
    await connect(w);
    const gateway = w.harness.dependencies.storageConnectionService;
    w.harness.storage.failNext('unavailable');
    await expect(
      gateway.run(({ provider, credentials }) => provider.checkHealth(credentials).then(() => 1)),
    ).resolves.toBe(1); // checkHealth reports unhealthy rather than throwing

    w.harness.storage.failNext('unavailable');
    await expect(
      gateway.run(({ provider, credentials }) => provider.getItem(credentials, 'x')),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    expect(w.harness.state.storageConnection).toMatchObject({
      status: 'unavailable',
      healthReason: 'provider_unavailable',
    });

    w.harness.storage.failNext('rate_limited');
    await expect(
      gateway.runWithoutCredentials((provider) =>
        provider.uploadChunk({
          session: { handle: 'h', expiresAt: '2030-01-01T00:00:00.000Z', nextOffset: 0 },
          offset: 0,
          totalSize: 1,
          bytes: new Uint8Array(1),
        }),
      ),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    expect(w.harness.state.storageConnection?.healthReason).toBe('rate_limited');

    // Still usable while unavailable; a success marks it healthy again.
    await expect(
      gateway.run(({ provider, credentials }) => provider.getItem(credentials, 'x')),
    ).resolves.toBeNull();
    expect(w.harness.state.storageConnection).toMatchObject({
      status: 'healthy',
      healthReason: null,
    });
    expect(
      w.harness.state.auditEvents
        .filter((event) => event.action === 'storage.health_changed')
        .map((event) => `${String(event.metadata['from'])}->${String(event.metadata['to'])}`),
    ).toEqual(['healthy->unavailable', 'unavailable->healthy']);
  });

  it('never lets a success clear a concurrently recorded reconnect-required state', async () => {
    const w = await world();
    await connect(w);
    const gateway = w.harness.dependencies.storageConnectionService;
    w.harness.storage.failNext('unavailable');
    await expect(
      gateway.run(({ provider, credentials }) => provider.getItem(credentials, 'x')),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    // This operation starts while unavailable; consent is revoked elsewhere
    // before it finishes.
    await expect(
      gateway.run(({ provider, credentials }) => {
        const record = w.harness.state.storageConnection;
        if (record === null) throw new Error('no record');
        w.harness.state.storageConnection = {
          ...record,
          status: 'reconnect_required',
          healthReason: 'consent_revoked',
          version: record.version + 1,
        };
        return provider.getItem(credentials, 'x');
      }),
    ).resolves.toBeNull();
    expect(w.harness.state.storageConnection).toMatchObject({
      status: 'reconnect_required',
      healthReason: 'consent_revoked',
    });
  });

  it('passes item-level provider errors through unchanged', async () => {
    const w = await world();
    await connect(w);
    w.harness.storage.failNext('not_found');
    await expect(
      w.harness.dependencies.storageConnectionService.run(({ provider, credentials }) =>
        provider.getItem(credentials, 'x'),
      ),
    ).rejects.toBeInstanceOf(StorageProviderError);
    expect(w.harness.state.storageConnection?.status).toBe('healthy');
  });
});

describe('configuration (TD-402)', () => {
  it('answers 503 when no provider is configured', async () => {
    const w = await world({ storageProvider: null });
    const response = await w.call('/api/v1/storage/connection/authorize', {
      as: 'administrator',
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(response.data['code']).toBe('STORAGE_NOT_CONFIGURED');
    const status = await w.call('/api/v1/storage/connection', { as: 'administrator' });
    expect(status.data).toMatchObject({ configured: false, healthReason: 'not_configured' });
    await expect(
      w.harness.dependencies.storageConnectionService.run(() => Promise.resolve(1)),
    ).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' });
  });

  it('answers 503 when the storage token key is missing', async () => {
    const w = await world({ storageKey: false });
    const response = await w.call('/api/v1/storage/connection/authorize', {
      as: 'administrator',
      method: 'POST',
    });
    expect(response.status).toBe(503);
    expect(response.data['code']).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('refuses to start consent without a public app URL', async () => {
    const harness = createTestHarness();
    const service = new StorageConnectionService({
      repositories: harness.repositories,
      unitOfWork: harness.unitOfWork,
      provider: createFakeStorageProvider(),
      cipher: createSecretCipher(TEST_STORAGE_KEY, 1, 'storage token encryption key'),
      tokenHasher: createTokenHasher(),
      clock: harness.now,
      redirectUri: undefined,
    });
    expect(service.configured).toBe(false);
    await expect(
      service.beginAuthorization({ actorUserId: 'x', requestId: 'r' }),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_NOT_CONFIGURED' });
  });

  it('treats unreadable stored credentials as reconnect-required', async () => {
    const w = await world();
    await connect(w);
    const record = w.harness.state.storageConnection;
    if (record === null) throw new Error('no record');
    w.harness.state.storageConnection = { ...record, tokenCiphertext: 'v1.AAAA.BBBB' };
    await expect(
      w.harness.dependencies.storageConnectionService.run(() => Promise.resolve(1)),
    ).rejects.toMatchObject({ code: 'STORAGE_RECONNECT_REQUIRED' });
    expect(w.harness.state.storageConnection).toMatchObject({ status: 'reconnect_required' });
  });
});

describe('secret handling (TD-402)', () => {
  it('never exposes tokens or the OAuth state in responses, audit, or stored state rows', async () => {
    const w = await world();
    const state = await authorize(w);
    await callback(w, { code: w.harness.storage.validCode, state });
    const first = await storedCredentials(w);
    w.harness.advance(2 * HOUR);
    await w.call('/api/v1/storage/connection/check', { as: 'administrator', method: 'POST' });
    const second = await storedCredentials(w);
    await w.call('/api/v1/storage/connection', { as: 'administrator' });
    await w.call('/api/v1/storage/connection', { as: 'consultant' });

    const secrets = [
      first.accessToken,
      first.refreshToken,
      second.accessToken,
      second.refreshToken,
    ];
    const stored = [
      JSON.stringify(w.harness.state.auditEvents),
      JSON.stringify([...w.harness.state.storageOAuthStates.values()]),
    ];
    for (const secret of secrets) {
      for (const haystack of [...w.bodies, ...stored]) {
        expect(haystack).not.toContain(secret);
      }
    }
    // The state travels only in the consent URL; it is never stored or audited.
    for (const haystack of stored) {
      expect(haystack).not.toContain(state);
    }
    expect(w.harness.storage.calls['refreshCredentials']).toBe(1);
  });
});

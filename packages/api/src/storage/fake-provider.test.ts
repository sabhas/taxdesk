import { describe, expect, it } from 'vitest';
import { createFakeStorageProvider } from './fake-provider.js';
import { StorageProviderError, type ProviderConnectionGrant } from './provider.js';

const VERIFIER = 'v'.repeat(43);

async function connect() {
  let now = new Date('2026-11-11T10:00:00.000Z');
  const provider = createFakeStorageProvider({ clock: () => now });
  const grant: ProviderConnectionGrant = await provider.completeConnection({
    code: provider.validCode,
    codeVerifier: VERIFIER,
    redirectUri: 'https://taxdesk.test/cb',
  });
  return {
    provider,
    grant,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageProviderError) {
      return error.kind;
    }
    throw error;
  }
  return 'resolved';
}

const path = {
  segments: ['clients', 'CL-00001', 'general', 'client-documents', 'd1'],
  fileName: 'a.pdf',
};

describe('fake storage provider (port contract)', () => {
  it('rejects a wrong authorization code', async () => {
    const provider = createFakeStorageProvider();
    expect(
      await kindOf(
        provider.completeConnection({ code: 'nope', codeVerifier: VERIFIER, redirectUri: 'x' }),
      ),
    ).toBe('rejected');
  });

  it('uploads resumably and completes with item metadata', async () => {
    const { provider, grant } = await connect();
    const session = await provider.createUploadSession(grant.credentials, { path, sizeBytes: 10 });
    expect(session.nextOffset).toBe(0);
    const first = await provider.uploadChunk({
      session,
      offset: 0,
      totalSize: 10,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(first).toEqual({ kind: 'partial', nextOffset: 4 });
    expect((await provider.getUploadSession(session)).nextOffset).toBe(4);

    const conflict = provider.uploadChunk({
      session,
      offset: 0,
      totalSize: 10,
      bytes: new Uint8Array(2),
    });
    await expect(conflict).rejects.toMatchObject({ kind: 'conflict', expectedOffset: 4 });

    const last = await provider.uploadChunk({
      session,
      offset: 4,
      totalSize: 10,
      bytes: new Uint8Array([5, 6, 7, 8, 9, 10]),
    });
    expect(last.kind).toBe('complete');
    if (last.kind !== 'complete') {
      return;
    }
    expect(last.item.sizeBytes).toBe(10);
    const item = await provider.getItem(grant.credentials, last.item.externalItemId);
    expect(item?.parentId).toBe(last.item.parentId);
    expect([...(provider.contentOf(last.item.externalItemId) ?? [])]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const download = await provider.download(grant.credentials, last.item.externalItemId);
    expect(new Uint8Array(await new Response(download.body).arrayBuffer())).toHaveLength(10);
    // The completed session is gone.
    expect(await kindOf(provider.getUploadSession(session))).toBe('not_found');
  });

  it('refuses a second item at the same location and cancelled sessions', async () => {
    const { provider, grant } = await connect();
    const session = await provider.createUploadSession(grant.credentials, { path, sizeBytes: 1 });
    await provider.uploadChunk({ session, offset: 0, totalSize: 1, bytes: new Uint8Array(1) });
    expect(
      await kindOf(provider.createUploadSession(grant.credentials, { path, sizeBytes: 1 })),
    ).toBe('conflict');
    const other = await provider.createUploadSession(grant.credentials, {
      path: { ...path, fileName: 'b.pdf' },
      sizeBytes: 1,
    });
    await provider.cancelUploadSession(other);
    expect(
      await kindOf(
        provider.uploadChunk({ session: other, offset: 0, totalSize: 1, bytes: new Uint8Array(1) }),
      ),
    ).toBe('not_found');
  });

  it('trashes, restores, and loses purged items', async () => {
    const { provider, grant } = await connect();
    const session = await provider.createUploadSession(grant.credentials, { path, sizeBytes: 1 });
    const done = await provider.uploadChunk({
      session,
      offset: 0,
      totalSize: 1,
      bytes: new Uint8Array(1),
    });
    if (done.kind !== 'complete') {
      throw new Error('expected complete');
    }
    const id = done.item.externalItemId;
    await provider.trash(grant.credentials, id);
    expect((await provider.getItem(grant.credentials, id))?.trashed).toBe(true);
    expect(await kindOf(provider.download(grant.credentials, id))).toBe('not_found');
    expect(await provider.restore(grant.credentials, id)).toBe('restored');
    expect((await provider.getItem(grant.credentials, id))?.trashed).toBe(false);
    await provider.trash(grant.credentials, id);
    provider.purgeTrash();
    expect(await provider.restore(grant.credentials, id)).toBe('not_recoverable');
    expect(await provider.getItem(grant.credentials, id)).toBeNull();
  });

  it('reports external removal and moves', async () => {
    const { provider, grant } = await connect();
    const session = await provider.createUploadSession(grant.credentials, { path, sizeBytes: 1 });
    const done = await provider.uploadChunk({
      session,
      offset: 0,
      totalSize: 1,
      bytes: new Uint8Array(1),
    });
    if (done.kind !== 'complete') {
      throw new Error('expected complete');
    }
    provider.moveExternally(done.item.externalItemId, 'elsewhere');
    expect((await provider.getItem(grant.credentials, done.item.externalItemId))?.parentId).toBe(
      'elsewhere',
    );
    provider.removeExternally(done.item.externalItemId);
    expect(await provider.getItem(grant.credentials, done.item.externalItemId)).toBeNull();
  });

  it('rotates refresh tokens and rejects the old one', async () => {
    const { provider, grant } = await connect();
    const next = await provider.refreshCredentials(grant.credentials);
    expect(next.refreshToken).not.toBe(grant.credentials.refreshToken);
    expect(await kindOf(provider.refreshCredentials(grant.credentials))).toBe('reconnect_required');
    expect(await kindOf(provider.getItem(grant.credentials, 'x'))).toBe('unauthorized');
    expect(await provider.getItem(next, 'x')).toBeNull();
  });

  it('expires access tokens on demand', async () => {
    const { provider, grant } = await connect();
    provider.expireAccessTokens();
    expect(await kindOf(provider.getItem(grant.credentials, 'x'))).toBe('unauthorized');
    const refreshed = await provider.refreshCredentials(grant.credentials);
    expect(await provider.getItem(refreshed, 'x')).toBeNull();
  });

  it('turns revoked consent into reconnect_required everywhere', async () => {
    const { provider, grant } = await connect();
    provider.revokeConsent();
    expect(await kindOf(provider.refreshCredentials(grant.credentials))).toBe('reconnect_required');
    expect(await kindOf(provider.getItem(grant.credentials, 'x'))).toBe('reconnect_required');
    const health = await provider.checkHealth(grant.credentials);
    expect(health.kind === 'unhealthy' && health.error.kind).toBe('reconnect_required');
    // A fresh consent restores access.
    const again = await provider.completeConnection({
      code: provider.validCode,
      codeVerifier: VERIFIER,
      redirectUri: 'x',
    });
    expect((await provider.checkHealth(again.credentials)).kind).toBe('healthy');
  });

  it('injects transient failures for a set number of calls', async () => {
    const { provider, grant } = await connect();
    provider.failNext('unavailable', 2);
    expect(await kindOf(provider.getItem(grant.credentials, 'x'))).toBe('unavailable');
    expect(await kindOf(provider.getItem(grant.credentials, 'x'))).toBe('unavailable');
    expect(await provider.getItem(grant.credentials, 'x')).toBeNull();
    expect(provider.calls['getItem']).toBe(3);
  });

  it('expires upload sessions after their lifetime', async () => {
    const { provider, grant, advance } = await connect();
    const session = await provider.createUploadSession(grant.credentials, { path, sizeBytes: 2 });
    advance(25 * 3600 * 1000);
    expect(
      await kindOf(
        provider.uploadChunk({ session, offset: 0, totalSize: 2, bytes: new Uint8Array(1) }),
      ),
    ).toBe('not_found');
  });
});

import { describe, expect, it } from 'vitest';
import { GraphTokenError, type GraphOAuthConfig, type TokenSet } from '../graph/oauth.js';
import { SpikeTokenSession } from './token-session.js';

const config: GraphOAuthConfig = {
  clientId: '8f2f2f3a-0b3c-4d5e-8f90-1a2b3c4d5e6f',
  tenant: 'consumers',
  redirectUri: 'http://localhost:8788/oauth/callback',
};

const initialTokens: TokenSet = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  expiresInSeconds: 3600,
  grantedScopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
  tokenType: 'Bearer',
};

function createFetch(handler: () => Response): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    return handler();
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createSession(
  overrides: {
    fetchHandler?: () => Response;
    initial?: TokenSet;
    skipRevocationCheck?: boolean;
    confirmRevocation?: () => Promise<boolean>;
    authorizeAgain?: () => Promise<TokenSet>;
  } = {},
) {
  const { fetchImpl, bodies } = createFetch(
    overrides.fetchHandler ??
      (() =>
        tokenResponse({
          access_token: 'access-token-2',
          refresh_token: 'refresh-token-2',
          expires_in: 3599,
        })),
  );
  const session = new SpikeTokenSession({
    fetchImpl,
    config,
    initialTokens: overrides.initial ?? initialTokens,
    skipRevocationCheck: overrides.skipRevocationCheck ?? false,
    confirmRevocation: overrides.confirmRevocation ?? (() => Promise.resolve(true)),
    authorizeAgain:
      overrides.authorizeAgain ??
      (() =>
        Promise.resolve({
          ...initialTokens,
          accessToken: 'access-token-reconnected',
          refreshToken: 'refresh-token-reconnected',
        })),
  });
  return { session, bodies };
}

describe('SpikeTokenSession', () => {
  it('exposes the granted scopes and access-token lifetime from consent', () => {
    const { session } = createSession();
    expect(session.hasRefreshToken()).toBe(true);
    expect(session.grantedScopes()).toEqual(['Files.ReadWrite.AppFolder', 'offline_access']);
    expect(session.accessTokenExpiresInSeconds()).toBe(3600);
    expect(session.accessToken).toBe('access-token-1');
  });

  it('adopts a rotated refresh token so the next refresh still works', async () => {
    const { session } = createSession();
    const result = await session.refresh();

    expect(result).toEqual({ expiresInSeconds: 3599, refreshTokenRotated: true });
    expect(session.accessToken).toBe('access-token-2');
  });

  it('keeps the existing refresh token when the provider does not rotate it', async () => {
    const { session, bodies } = createSession({
      fetchHandler: () => tokenResponse({ access_token: 'access-token-2', expires_in: 3599 }),
    });

    const result = await session.refresh();
    expect(result.refreshTokenRotated).toBe(false);
    expect(session.accessToken).toBe('access-token-2');

    await session.refresh();
    expect(new URLSearchParams(bodies[1]).get('refresh_token')).toBe('refresh-token-1');
  });

  it('refuses to refresh without a refresh token', async () => {
    const { session } = createSession({
      initial: { ...initialTokens, refreshToken: undefined },
    });

    const error = await session.refresh().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphTokenError);
    expect((error as GraphTokenError).code).toBe('missing_refresh_token');
  });

  it('reports revoked consent as reconnect-required', async () => {
    const { session } = createSession({
      fetchHandler: () => tokenResponse({ error: 'invalid_grant' }, 400),
    });

    await expect(session.observeConsentRevocation()).resolves.toEqual({
      status: 'revoked',
      errorCode: 'invalid_grant',
      httpStatus: 400,
      reconnectRequired: true,
    });
  });

  it('reports consent as still active when a refresh succeeds', async () => {
    const { session } = createSession();
    await expect(session.observeConsentRevocation()).resolves.toEqual({ status: 'still_active' });
    expect(session.accessToken).toBe('access-token-2');
  });

  it('skips the revocation check when the operator declined', async () => {
    const { session } = createSession({ confirmRevocation: () => Promise.resolve(false) });
    const observation = await session.observeConsentRevocation();

    expect(observation.status).toBe('skipped');
    if (observation.status !== 'skipped') throw new Error('expected a skip');
    expect(observation.reason).toContain('not revoked');
  });

  it('skips the revocation check when the flag was passed', async () => {
    const { session } = createSession({ skipRevocationCheck: true });
    const observation = await session.observeConsentRevocation();

    expect(observation.status).toBe('skipped');
    if (observation.status !== 'skipped') throw new Error('expected a skip');
    expect(observation.reason).toContain('skipped');
  });

  it('re-establishes delegated consent after revocation', async () => {
    const { session } = createSession();
    await expect(session.reconnect()).resolves.toBe(true);
    expect(session.accessToken).toBe('access-token-reconnected');
  });

  it('reports a failed reconnect without throwing', async () => {
    const { session } = createSession({
      authorizeAgain: () => Promise.reject(new Error('consent window closed')),
    });
    await expect(session.reconnect()).resolves.toBe(false);
  });
});

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_PERSONAL_TENANT,
  GraphTokenError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  graphOAuthEndpoints,
  refreshAccessToken,
  type GraphOAuthConfig,
} from './oauth.js';

const config: GraphOAuthConfig = {
  clientId: '8f2f2f3a-0b3c-4d5e-8f90-1a2b3c4d5e6f',
  tenant: GRAPH_PERSONAL_TENANT,
  redirectUri: 'http://localhost:8788/oauth/callback',
};

interface RecordedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: string;
  readonly headers: Record<string, string>;
}

function createFetch(handler: (request: RecordedRequest) => Response): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : '',
      headers: Object.fromEntries(headers.entries()),
    };
    requests.push(request);
    return handler(request);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function zeroBytes(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe('graphOAuthEndpoints', () => {
  it('targets the personal-account consumers tenant', () => {
    expect(graphOAuthEndpoints('consumers')).toEqual({
      authorize: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
      token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    });
  });
});

describe('createPkcePair', () => {
  it('derives the S256 challenge from a 43-character verifier', async () => {
    const pair = await createPkcePair(zeroBytes);
    const expectedChallenge = Buffer.from(
      createHash('sha256').update(pair.verifier).digest(),
    ).toString('base64url');

    expect(pair.verifier).toHaveLength(43);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toBe(expectedChallenge);
  });
});

describe('buildAuthorizeUrl', () => {
  it('requests exactly the documented minimum scopes with PKCE', () => {
    const url = new URL(
      buildAuthorizeUrl({ config, state: 'state-123', codeChallenge: 'challenge-abc' }),
    );

    expect(url.origin + url.pathname).toBe(graphOAuthEndpoints('consumers').authorize);
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('scope')).toBe('offline_access Files.ReadWrite.AppFolder');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('forces the consent screen when re-establishing a revoked grant', () => {
    const url = new URL(
      buildAuthorizeUrl({
        config,
        state: 'state-123',
        codeChallenge: 'challenge-abc',
        forceConsent: true,
      }),
    );
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('never asks for whole-drive or tenant-wide permissions', () => {
    const url = new URL(
      buildAuthorizeUrl({ config, state: 'state-123', codeChallenge: 'challenge-abc' }),
    );
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).not.toContain('Files.ReadWrite.All');
    expect(scope).not.toContain('Files.Read.All');
    expect(scope).not.toContain('Sites.');
    expect(scope.split(' ')).toEqual(['offline_access', 'Files.ReadWrite.AppFolder']);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts a form-encoded authorization-code request and maps the token set', async () => {
    const { fetchImpl, requests } = createFetch(() =>
      jsonResponse({
        access_token: 'access-token-value',
        refresh_token: 'refresh-token-value',
        expires_in: 3600,
        scope: 'Files.ReadWrite.AppFolder offline_access',
        token_type: 'Bearer',
      }),
    );

    const tokens = await exchangeAuthorizationCode(fetchImpl, {
      config,
      code: 'authorization-code-value',
      codeVerifier: 'verifier-value',
    });

    expect(tokens).toEqual({
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      expiresInSeconds: 3600,
      grantedScopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
      tokenType: 'Bearer',
    });

    const request = requests[0];
    expect(request?.url).toBe(graphOAuthEndpoints('consumers').token);
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(request?.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('authorization-code-value');
    expect(body.get('code_verifier')).toBe('verifier-value');
    expect(body.get('redirect_uri')).toBe(config.redirectUri);
    expect(body.get('scope')).toBe('offline_access Files.ReadWrite.AppFolder');
    expect(body.get('client_secret')).toBeNull();
  });

  it('reduces a rejected grant to a reconnect-required error code', async () => {
    const { fetchImpl } = createFetch(() =>
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'AADSTS70008: The provided authorization code expired. secret-value',
        },
        400,
      ),
    );

    const error = await exchangeAuthorizationCode(fetchImpl, {
      config,
      code: 'authorization-code-value',
      codeVerifier: 'verifier-value',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphTokenError);
    const tokenError = error as GraphTokenError;
    expect(tokenError.code).toBe('invalid_grant');
    expect(tokenError.httpStatus).toBe(400);
    expect(tokenError.reconnectRequired).toBe(true);
    expect(tokenError.message).not.toContain('AADSTS70008');
    expect(tokenError.message).not.toContain('authorization-code-value');
  });

  it('reports an unusable success payload as an invalid token response', async () => {
    const { fetchImpl } = createFetch(() => jsonResponse({ token_type: 'Bearer' }, 200));
    const error = await exchangeAuthorizationCode(fetchImpl, {
      config,
      code: 'code',
      codeVerifier: 'verifier',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphTokenError);
    expect((error as GraphTokenError).code).toBe('invalid_token_response');
  });
});

describe('refreshAccessToken', () => {
  it('redeems a refresh token without re-requesting scopes', async () => {
    const { fetchImpl, requests } = createFetch(() =>
      jsonResponse({
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3599,
      }),
    );

    const tokens = await refreshAccessToken(fetchImpl, {
      config,
      refreshToken: 'current-refresh-token',
    });

    expect(tokens.accessToken).toBe('new-access-token');
    expect(tokens.refreshToken).toBe('rotated-refresh-token');
    expect(tokens.expiresInSeconds).toBe(3599);
    expect(tokens.grantedScopes).toEqual([]);
    expect(tokens.tokenType).toBe('Bearer');

    const body = new URLSearchParams(requests[0]?.body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('current-refresh-token');
    expect(body.get('scope')).toBeNull();
  });

  it('does not classify a transient outage as reconnect-required', async () => {
    const { fetchImpl } = createFetch(() =>
      jsonResponse({ error: 'temporarily_unavailable' }, 503),
    );
    const error = await refreshAccessToken(fetchImpl, {
      config,
      refreshToken: 'current-refresh-token',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GraphTokenError);
    expect((error as GraphTokenError).reconnectRequired).toBe(false);
    expect((error as GraphTokenError).httpStatus).toBe(503);
  });
});

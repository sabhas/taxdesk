import { z } from 'zod';
import type { ProviderCredentials } from '../provider.js';
import {
  errorForResponse,
  providerError,
  readErrorCode,
  readJson,
  safeFetch,
  type FetchLike,
} from './http.js';

/**
 * Microsoft identity platform (v2.0) delegated authorization for the OneDrive
 * adapter: authorization code + PKCE (S256) and refresh-token rotation.
 *
 * The scope set is the TD-005 proven minimum. Microsoft does not echo
 * `offline_access` in the granted scopes, so offline access is proven by the
 * presence of a refresh token, never by string matching.
 */

export const MICROSOFT_IDENTITY_HOST = 'https://login.microsoftonline.com';
export const DEFAULT_ONEDRIVE_AUTHORITY = 'consumers';
export const ONEDRIVE_SCOPES = ['Files.ReadWrite.AppFolder', 'offline_access'] as const;

export interface OneDriveOAuthConfig {
  readonly clientId: string;
  /** Only sent when the app registration is a confidential web app. */
  readonly clientSecret?: string | undefined;
  /** Tenant segment; `consumers` for personal Microsoft accounts. */
  readonly authority?: string | undefined;
}

export function oauthEndpoints(authority: string | undefined): {
  readonly authorize: string;
  readonly token: string;
} {
  const tenant = encodeURIComponent(authority ?? DEFAULT_ONEDRIVE_AUTHORITY);
  const base = `${MICROSOFT_IDENTITY_HOST}/${tenant}/oauth2/v2.0`;
  return { authorize: `${base}/authorize`, token: `${base}/token` };
}

export function buildAuthorizationUrl(
  config: OneDriveOAuthConfig,
  input: { readonly state: string; readonly codeChallenge: string; readonly redirectUri: string },
): string {
  const url = new URL(oauthEndpoints(config.authority).authorize);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', ONEDRIVE_SCOPES.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Always show consent so a reconnect re-grants after a revocation.
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().optional(),
});

/** Identity error codes that mean the grant is gone and consent must be redone. */
const RECONNECT_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
]);

/** Identity error codes that mean the deployment's app registration is wrong. */
const CONFIGURATION_CODES: ReadonlySet<string> = new Set([
  'invalid_client',
  'unauthorized_client',
  'invalid_scope',
]);

interface TokenRequestDeps {
  readonly fetchImpl: FetchLike;
  readonly clock: () => Date;
  readonly timeoutMs: number;
}

async function requestToken(
  config: OneDriveOAuthConfig,
  deps: TokenRequestDeps,
  params: Record<string, string>,
): Promise<{
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresInSeconds: number;
  readonly scopes: readonly string[];
}> {
  const body = new URLSearchParams({ client_id: config.clientId, ...params });
  if (config.clientSecret !== undefined && config.clientSecret.length > 0) {
    body.set('client_secret', config.clientSecret);
  }
  const response = await safeFetch(
    deps.fetchImpl,
    oauthEndpoints(config.authority).token,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    },
    deps.timeoutMs,
  );
  const payload = await readJson(response);
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw errorForResponse(response, deps.clock());
    }
    const code = readErrorCode(payload);
    if (code !== null && RECONNECT_CODES.has(code)) {
      throw providerError('reconnect_required');
    }
    if (code !== null && CONFIGURATION_CODES.has(code)) {
      throw providerError('not_configured');
    }
    throw providerError('rejected');
  }
  const parsed = TokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw providerError('unavailable');
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    scopes: (parsed.data.scope ?? '')
      .split(' ')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  };
}

export async function exchangeAuthorizationCode(
  config: OneDriveOAuthConfig,
  deps: TokenRequestDeps,
  input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
): Promise<ProviderCredentials> {
  const tokens = await requestToken(config, deps, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    scope: ONEDRIVE_SCOPES.join(' '),
  });
  if (tokens.refreshToken === undefined) {
    // Without a refresh token the connection would silently die within an hour.
    throw providerError('rejected');
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: new Date(
      deps.clock().getTime() + tokens.expiresInSeconds * 1000,
    ).toISOString(),
    scopes: tokens.scopes,
  };
}

/**
 * Redeems the refresh token. Microsoft normally rotates it; when a response
 * carries no new refresh token the current one is kept.
 */
export async function refreshCredentials(
  config: OneDriveOAuthConfig,
  deps: TokenRequestDeps,
  credentials: ProviderCredentials,
): Promise<ProviderCredentials> {
  const tokens = await requestToken(config, deps, {
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    scope: ONEDRIVE_SCOPES.join(' '),
  });
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? credentials.refreshToken,
    accessTokenExpiresAt: new Date(
      deps.clock().getTime() + tokens.expiresInSeconds * 1000,
    ).toISOString(),
    scopes: tokens.scopes.length > 0 ? tokens.scopes : credentials.scopes,
  };
}

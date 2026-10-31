import { Buffer } from 'node:buffer';
import { ONEDRIVE_SPIKE_SCOPES, type OnedriveSpikeScope } from '@taxdesk/shared';
import { z } from 'zod';

/**
 * Microsoft identity platform client for the TD-005 spike only.
 *
 * This module is a throwaway harness, not the production `DocumentStorageProvider`
 * adapter: it holds no persistence, no encryption, and no refresh-token storage.
 * Every error it raises carries a Graph error code and HTTP status, never the
 * authorization code, access token, refresh token, or raw provider message.
 */

export const GRAPH_AUTHORITY = 'https://login.microsoftonline.com';

/** Personal Microsoft accounts are always served by the `consumers` tenant. */
export const GRAPH_PERSONAL_TENANT = 'consumers';

export interface GraphOAuthConfig {
  readonly clientId: string;
  readonly tenant: string;
  readonly redirectUri: string;
}

export interface GraphOAuthEndpoints {
  readonly authorize: string;
  readonly token: string;
}

export function graphOAuthEndpoints(tenant: string): GraphOAuthEndpoints {
  const base = `${GRAPH_AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  return { authorize: `${base}/authorize`, token: `${base}/token` };
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export type RandomBytes = (size: number) => Uint8Array;

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Builds an S256 PKCE pair. The verifier never leaves the process; only the
 * challenge is placed in the authorize URL.
 */
export async function createPkcePair(randomBytes: RandomBytes): Promise<PkcePair> {
  const verifier = base64UrlEncode(randomBytes(32));
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export interface AuthorizeUrlOptions {
  readonly config: GraphOAuthConfig;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes?: readonly OnedriveSpikeScope[];
  readonly forceConsent?: boolean;
}

/**
 * Builds the delegated authorization URL. The scope list is fixed to the
 * documented minimum unless a caller passes an explicit subset for a test.
 */
export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const scopes = options.scopes ?? ONEDRIVE_SPIKE_SCOPES;
  const url = new URL(graphOAuthEndpoints(options.config.tenant).authorize);
  url.searchParams.set('client_id', options.config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', options.config.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.forceConsent === true) {
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().min(1).optional(),
});

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresInSeconds: number;
  readonly grantedScopes: readonly string[];
  readonly tokenType: string;
}

const RECONNECT_REQUIRED_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'invalid_client',
  'interaction_required',
  'consent_required',
  'login_required',
]);

/**
 * A token-endpoint failure reduced to the Graph error code and HTTP status. A
 * `reconnectRequired` error means the stored grant can no longer be refreshed
 * and the operator must complete delegated consent again.
 */
export class GraphTokenError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(`Microsoft identity token request failed with ${code} (HTTP ${String(httpStatus)}).`);
    this.name = 'GraphTokenError';
  }

  get reconnectRequired(): boolean {
    return RECONNECT_REQUIRED_CODES.has(this.code);
  }
}

function readJsonBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readErrorCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload;
    if (typeof error === 'string' && error.length > 0 && error.length <= 120) {
      return error;
    }
  }
  return 'unknown_token_error';
}

async function requestToken(
  fetchImpl: typeof fetch,
  tokenEndpoint: string,
  params: Readonly<Record<string, string>>,
): Promise<TokenSet> {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });

  const payload = readJsonBody(await response.text());

  if (!response.ok) {
    throw new GraphTokenError(readErrorCode(payload), response.status);
  }

  const parsed = TokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GraphTokenError('invalid_token_response', response.status);
  }

  const grantedScopes = (parsed.data.scope ?? '')
    .split(' ')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    grantedScopes,
    tokenType: parsed.data.token_type ?? 'Bearer',
  };
}

export interface AuthorizationCodeExchange {
  readonly config: GraphOAuthConfig;
  readonly code: string;
  readonly codeVerifier: string;
}

export async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  exchange: AuthorizationCodeExchange,
): Promise<TokenSet> {
  const { config } = exchange;
  return requestToken(fetchImpl, graphOAuthEndpoints(config.tenant).token, {
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code: exchange.code,
    redirect_uri: config.redirectUri,
    code_verifier: exchange.codeVerifier,
    scope: ONEDRIVE_SPIKE_SCOPES.join(' '),
  });
}

export interface RefreshRequest {
  readonly config: GraphOAuthConfig;
  readonly refreshToken: string;
}

/**
 * Redeems a refresh token. The scope is intentionally omitted so Microsoft
 * re-issues exactly the scopes the account already consented to.
 */
export async function refreshAccessToken(
  fetchImpl: typeof fetch,
  request: RefreshRequest,
): Promise<TokenSet> {
  const { config } = request;
  return requestToken(fetchImpl, graphOAuthEndpoints(config.tenant).token, {
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
    redirect_uri: config.redirectUri,
  });
}

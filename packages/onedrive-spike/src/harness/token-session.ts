import type { ConsentRevocationObservation, ScenarioTokens } from '../harness/scenarios.js';
import {
  GraphTokenError,
  refreshAccessToken,
  type GraphOAuthConfig,
  type TokenSet,
} from '../graph/oauth.js';

export interface SpikeTokenSessionOptions {
  readonly fetchImpl: typeof fetch;
  readonly config: GraphOAuthConfig;
  readonly initialTokens: TokenSet;
  readonly skipRevocationCheck: boolean;
  readonly confirmRevocation: () => Promise<boolean>;
  /** Runs a fresh delegated authorization-code flow for the reconnect check. */
  readonly authorizeAgain: () => Promise<TokenSet>;
}

/**
 * Holds the spike's delegated tokens in memory for the duration of one run.
 *
 * Nothing is persisted, encrypted, or logged: the refresh token lives only in
 * this object and the process exits at the end of the run. Rotation is applied
 * immediately so a rotated refresh token is never lost mid-run.
 */
export class SpikeTokenSession implements ScenarioTokens {
  private current: TokenSet;

  constructor(private readonly options: SpikeTokenSessionOptions) {
    this.current = options.initialTokens;
  }

  get accessToken(): string {
    return this.current.accessToken;
  }

  hasRefreshToken(): boolean {
    return this.current.refreshToken !== undefined;
  }

  grantedScopes(): readonly string[] {
    return this.current.grantedScopes;
  }

  accessTokenExpiresInSeconds(): number {
    return this.current.expiresInSeconds;
  }

  private requireRefreshToken(): string {
    const refreshToken = this.current.refreshToken;
    if (refreshToken === undefined) {
      throw new GraphTokenError('missing_refresh_token', 400);
    }
    return refreshToken;
  }

  private adopt(next: TokenSet, fallbackRefreshToken: string): void {
    this.current = {
      ...next,
      refreshToken: next.refreshToken ?? fallbackRefreshToken,
    };
  }

  async refresh(): Promise<{ expiresInSeconds: number; refreshTokenRotated: boolean }> {
    const refreshToken = this.requireRefreshToken();
    const next = await refreshAccessToken(this.options.fetchImpl, {
      config: this.options.config,
      refreshToken,
    });
    const rotated = next.refreshToken !== undefined && next.refreshToken !== refreshToken;
    this.adopt(next, refreshToken);
    return { expiresInSeconds: next.expiresInSeconds, refreshTokenRotated: rotated };
  }

  async observeConsentRevocation(): Promise<ConsentRevocationObservation> {
    if (this.options.skipRevocationCheck) {
      return {
        status: 'skipped',
        reason:
          'The operator skipped the revocation check, so revoked-consent behavior is not proven by this run.',
      };
    }

    const refreshToken = this.requireRefreshToken();
    const revoked = await this.options.confirmRevocation();
    if (!revoked) {
      return {
        status: 'skipped',
        reason:
          'Consent was not revoked at the Microsoft account consent page, so revoked-consent behavior is not proven by this run.',
      };
    }

    try {
      const next = await refreshAccessToken(this.options.fetchImpl, {
        config: this.options.config,
        refreshToken,
      });
      this.adopt(next, refreshToken);
      return { status: 'still_active' };
    } catch (error) {
      if (error instanceof GraphTokenError) {
        return {
          status: 'revoked',
          errorCode: error.code,
          httpStatus: error.httpStatus,
          reconnectRequired: error.reconnectRequired,
        };
      }
      throw error;
    }
  }

  async reconnect(): Promise<boolean> {
    try {
      this.current = await this.options.authorizeAgain();
      return true;
    } catch {
      return false;
    }
  }
}

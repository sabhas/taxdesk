import { LOGIN_THROTTLE_WINDOW_MS } from './session-policy.js';
import {
  evaluateLoginThrottle,
  throttleDenied,
  type LoginThrottleDecision,
} from './login-throttle.js';
import type { LoginAttemptRepository } from '../../repositories/ports.js';
import type { TokenHasher } from '../../crypto/token.js';
import { newUuidV7 } from '@taxdesk/shared';

export interface LoginKeys {
  readonly accountKey: string;
  readonly networkKey: string;
}

/**
 * Persisted login throttling keyed by hashed normalized email and hashed
 * network identity. Email addresses and IP addresses are not stored in clear
 * text in the attempts table.
 */
export class LoginThrottle {
  constructor(
    private readonly repository: LoginAttemptRepository,
    private readonly tokenHasher: TokenHasher,
    private readonly clock: () => Date,
  ) {}

  async keysFor(normalizedEmail: string, remoteIp: string | undefined): Promise<LoginKeys> {
    return {
      accountKey: await this.tokenHasher.hash(`account:${normalizedEmail}`),
      networkKey: await this.tokenHasher.hash(`network:${remoteIp ?? 'unknown'}`),
    };
  }

  async evaluate(keys: LoginKeys): Promise<LoginThrottleDecision> {
    const now = this.clock();
    const since = new Date(now.getTime() - LOGIN_THROTTLE_WINDOW_MS).toISOString();
    const counts = await this.repository.countFailures({
      accountKey: keys.accountKey,
      networkKey: keys.networkKey,
      since,
    });
    return evaluateLoginThrottle(counts);
  }

  async record(keys: LoginKeys, succeeded: boolean): Promise<void> {
    const now = this.clock();
    await this.repository.record({
      id: newUuidV7(now.getTime()),
      accountKey: keys.accountKey,
      networkKey: keys.networkKey,
      succeeded,
      createdAt: now.toISOString(),
    });
  }

  async prune(): Promise<void> {
    const now = this.clock();
    await this.repository.pruneBefore(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
  }
}

export { throttleDenied };

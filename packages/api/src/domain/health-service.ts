import { HealthSchema, type Health } from '@taxdesk/shared';
import type { RuntimeConfig } from '../config.js';

/**
 * Builds the public health payload. The service deliberately receives only
 * environment and release version from validated configuration so it cannot
 * read or forward database, secret, or infrastructure details.
 */
export class HealthService {
  constructor(private readonly config: RuntimeConfig) {}

  getHealth(requestId: string): Health {
    const health = {
      environment: this.config.environment,
      releaseVersion: this.config.releaseVersion,
      requestId,
    };
    return HealthSchema.parse(health);
  }
}

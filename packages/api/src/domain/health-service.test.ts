import { describe, expect, it } from 'vitest';
import { HealthSchema } from '@taxdesk/shared';
import { HealthService } from './health-service.js';

describe('HealthService', () => {
  it('returns environment, release version, and request ID only', () => {
    const service = new HealthService({ environment: 'staging', releaseVersion: '1.2.3' });
    const health = service.getHealth('req-abc');
    expect(HealthSchema.safeParse(health).success).toBe(true);
    expect(health).toEqual({
      environment: 'staging',
      releaseVersion: '1.2.3',
      requestId: 'req-abc',
    });
    expect(Object.keys(health).sort()).toEqual(['environment', 'releaseVersion', 'requestId']);
  });
});

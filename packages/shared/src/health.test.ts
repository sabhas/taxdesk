import { describe, expect, it } from 'vitest';
import { HealthSchema } from './health.js';

describe('HealthSchema', () => {
  it('accepts a valid health payload', () => {
    const result = HealthSchema.safeParse({
      environment: 'staging',
      releaseVersion: '1.2.3',
      requestId: 'req-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown environment', () => {
    const result = HealthSchema.safeParse({
      environment: 'local',
      releaseVersion: '1.2.3',
      requestId: 'req-123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty release version or request ID', () => {
    expect(
      HealthSchema.safeParse({ environment: 'production', releaseVersion: '', requestId: 'req' })
        .success,
    ).toBe(false);
    expect(
      HealthSchema.safeParse({ environment: 'production', releaseVersion: '1.0.0', requestId: '' })
        .success,
    ).toBe(false);
  });

  it('rejects payloads containing extra infrastructure fields', () => {
    const result = HealthSchema.safeParse({
      environment: 'production',
      releaseVersion: '1.0.0',
      requestId: 'req-123',
      databaseName: 'taxdesk_production',
      hyperdrive: 'postgres://user:pass@db.internal:5432/taxdesk',
    });
    expect(result.success).toBe(false);
  });
});

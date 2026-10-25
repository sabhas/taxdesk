import { describe, expect, it } from 'vitest';
import { AppInfoSchema } from './app-info.js';

describe('AppInfoSchema', () => {
  it('accepts valid app info', () => {
    const result = AppInfoSchema.safeParse({
      name: 'TaxDesk',
      version: '0.1.0',
      environment: 'development',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown environment', () => {
    const result = AppInfoSchema.safeParse({
      name: 'TaxDesk',
      version: '0.1.0',
      environment: 'local',
    });
    expect(result.success).toBe(false);
  });
});

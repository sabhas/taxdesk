import { describe, expect, it } from 'vitest';
import { AppInfoSchema } from '@taxdesk/shared';
import { AppInfoService } from './app-info-service.js';

describe('AppInfoService', () => {
  it('returns app info matching the shared contract', () => {
    const service = new AppInfoService('Test API', '1.2.3', 'staging');
    const appInfo = service.getAppInfo();
    expect(AppInfoSchema.safeParse(appInfo).success).toBe(true);
    expect(appInfo).toEqual({ name: 'Test API', version: '1.2.3', environment: 'staging' });
  });
});

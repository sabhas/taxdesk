import type { AppInfo } from '@taxdesk/shared';

export class AppInfoService {
  constructor(
    private readonly name = 'TaxDesk API',
    private readonly version = '0.0.0',
    private readonly environment: AppInfo['environment'] = 'development',
  ) {}

  getAppInfo(): AppInfo {
    return {
      name: this.name,
      version: this.version,
      environment: this.environment,
    };
  }
}

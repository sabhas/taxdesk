import type { AppInfo } from '@taxdesk/shared';

/**
 * Formats the public app-info payload.
 *
 * Every value is required. An earlier version defaulted `environment` to
 * `development`, which type-checked and then made the deployed staging Worker
 * report the wrong environment — a default that silently outranked real
 * configuration. Requiring all three makes the compiler demand that the route
 * pass the resolved runtime configuration.
 */
export class AppInfoService {
  constructor(
    private readonly name: string,
    private readonly version: string,
    private readonly environment: AppInfo['environment'],
  ) {}

  getAppInfo(): AppInfo {
    return {
      name: this.name,
      version: this.version,
      environment: this.environment,
    };
  }
}

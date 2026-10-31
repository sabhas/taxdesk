import type { CheckResult } from './contracts.js';

export interface StagingConfigSources {
  readonly apiWranglerToml: string;
  readonly webWranglerToml: string;
  readonly databaseClientSource: string;
}

export interface StagingConfigReport {
  readonly check: 'config-posture';
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly failed: readonly string[];
}

function check(id: string, passed: boolean, detail: string): CheckResult {
  return { id, passed, detail };
}

/** Returns a TOML section body, stopping at the next table header line. */
function section(content: string, header: string): string {
  const start = content.indexOf(header);
  if (start === -1) {
    return '';
  }
  const rest = content.slice(start + header.length);
  const nextHeader = rest.search(/^\[/m);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
}

/**
 * Confirms the committed staging configuration cannot silently downgrade
 * Hyperdrive: the staging binding has a real Hyperdrive ID, no local
 * development connection string, the Pages preview binds to the staging Worker,
 * and the database client still enforces TLS.
 *
 * This is a static complement to `pnpm ci:db-posture`, which checks the live
 * session and role after the migration step.
 */
export function evaluateStagingConfig(sources: StagingConfigSources): StagingConfigReport {
  const staging = section(sources.apiWranglerToml, '[env.staging]');
  const stagingHyperdrive = section(sources.apiWranglerToml, '[[env.staging.hyperdrive]]');
  const stagingPages = section(sources.webWranglerToml, '[[env.preview.services]]');

  const hyperdriveId = /id\s*=\s*"([^"]+)"/.exec(stagingHyperdrive)?.[1] ?? '';
  const hasLocalConnection =
    staging.includes('localConnectionString') ||
    stagingHyperdrive.includes('localConnectionString');
  const hasInlineConnection = /postgres(?:ql)?:\/\//.test(staging + stagingHyperdrive);

  const checks: CheckResult[] = [
    check(
      'STAGING_API_NAME',
      /name\s*=\s*"taxdesk-api-staging"/.test(staging),
      /name\s*=\s*"taxdesk-api-staging"/.test(staging)
        ? 'The staging Worker is named taxdesk-api-staging.'
        : 'The staging Worker name is missing or wrong.',
    ),
    check(
      'STAGING_HYPERDRIVE_BINDING',
      /binding\s*=\s*"HYPERDRIVE"/.test(stagingHyperdrive),
      /binding\s*=\s*"HYPERDRIVE"/.test(stagingHyperdrive)
        ? 'The staging Hyperdrive binding is HYPERDRIVE.'
        : 'The staging Hyperdrive binding is missing.',
    ),
    check(
      'STAGING_HYPERDRIVE_ID',
      /^[0-9a-f]{32}$/.test(hyperdriveId) && !hyperdriveId.startsWith('REPLACE'),
      /^[0-9a-f]{32}$/.test(hyperdriveId)
        ? 'The staging Hyperdrive ID is a concrete configuration ID.'
        : 'The staging Hyperdrive ID is missing or still a placeholder.',
    ),
    check(
      'STAGING_HYPERDRIVE_NO_LOCAL_CONNECTION',
      !hasLocalConnection && !hasInlineConnection,
      hasLocalConnection || hasInlineConnection
        ? 'The staging Hyperdrive binding contains a local or inline connection string.'
        : 'The staging Hyperdrive binding contains no local or inline connection string.',
    ),
    check(
      'STAGING_PAGES_BINDING',
      /service\s*=\s*"taxdesk-api-staging"/.test(stagingPages),
      /service\s*=\s*"taxdesk-api-staging"/.test(stagingPages)
        ? 'The Pages staging preview binds to the staging Worker.'
        : 'The Pages staging preview binding is missing or wrong.',
    ),
    check(
      'DATABASE_CLIENT_REQUIRES_TLS',
      sources.databaseClientSource.includes("ssl: 'require'") &&
        sources.databaseClientSource.includes('prepare: false'),
      sources.databaseClientSource.includes("ssl: 'require'")
        ? 'The database client requires TLS and disables prepared statements.'
        : 'The database client does not require TLS.',
    ),
  ];

  const failed = checks.filter((entry) => !entry.passed).map((entry) => entry.id);
  return { check: 'config-posture', ok: failed.length === 0, checks, failed };
}

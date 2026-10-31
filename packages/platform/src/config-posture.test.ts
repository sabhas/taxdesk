import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateStagingConfig, type StagingConfigSources } from './config-posture.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sources(overrides: Partial<StagingConfigSources> = {}): StagingConfigSources {
  return {
    apiWranglerToml: [
      '[env.staging]',
      'name = "taxdesk-api-staging"',
      '',
      '[[env.staging.hyperdrive]]',
      'binding = "HYPERDRIVE"',
      'id = "0123456789abcdef0123456789abcdef"',
      '',
    ].join('\n'),
    webWranglerToml: [
      '[env.preview]',
      '[[env.preview.services]]',
      'binding = "API"',
      'service = "taxdesk-api-staging"',
      '',
    ].join('\n'),
    databaseClientSource: "postgres(connectionString, { prepare: false, ssl: 'require' });",
    ...overrides,
  };
}

describe('evaluateStagingConfig', () => {
  it('passes the committed staging configuration', async () => {
    const report = evaluateStagingConfig({
      apiWranglerToml: await readFile(join(REPOSITORY_ROOT, 'packages/api/wrangler.toml'), 'utf8'),
      webWranglerToml: await readFile(join(REPOSITORY_ROOT, 'packages/web/wrangler.toml'), 'utf8'),
      databaseClientSource: await readFile(
        join(REPOSITORY_ROOT, 'packages/database/src/index.ts'),
        'utf8',
      ),
    });
    expect(report.ok).toBe(true);
    expect(report.failed).toEqual([]);
  });

  it('fails a placeholder Hyperdrive ID', () => {
    const report = evaluateStagingConfig(
      sources({
        apiWranglerToml: sources().apiWranglerToml.replace(
          'id = "0123456789abcdef0123456789abcdef"',
          'id = "REPLACE_WITH_STAGING_HYPERDRIVE_ID"',
        ),
      }),
    );
    expect(report.failed).toEqual(['STAGING_HYPERDRIVE_ID']);
  });

  it('fails a staging local connection string', () => {
    const report = evaluateStagingConfig(
      sources({
        apiWranglerToml: sources().apiWranglerToml.replace(
          'binding = "HYPERDRIVE"',
          'binding = "HYPERDRIVE"\nlocalConnectionString = "postgres://taxdesk:taxdesk@localhost:5432/taxdesk"',
        ),
      }),
    );
    expect(report.failed).toEqual(['STAGING_HYPERDRIVE_NO_LOCAL_CONNECTION']);
  });

  it('fails when the Pages preview binds to another Worker', () => {
    const report = evaluateStagingConfig(
      sources({
        webWranglerToml: sources().webWranglerToml.replace('taxdesk-api-staging', 'taxdesk-api'),
      }),
    );
    expect(report.failed).toEqual(['STAGING_PAGES_BINDING']);
  });

  it('fails when the database client drops the TLS requirement', () => {
    const report = evaluateStagingConfig(
      sources({ databaseClientSource: 'postgres(connectionString, { prepare: false });' }),
    );
    expect(report.failed).toEqual(['DATABASE_CLIENT_REQUIRES_TLS']);
  });
});

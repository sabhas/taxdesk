import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig, type ApiBindings } from './config.js';

function bindings(overrides: Partial<ApiBindings> = {}): ApiBindings {
  return {
    ENVIRONMENT: 'development',
    RELEASE_VERSION: '0.0.0',
    ...overrides,
  };
}

describe('resolveRuntimeConfig', () => {
  it('resolves environment and release version from bindings', () => {
    expect(
      resolveRuntimeConfig(bindings({ ENVIRONMENT: 'staging', RELEASE_VERSION: '2.0.0' })),
    ).toEqual({ environment: 'staging', releaseVersion: '2.0.0' });
  });

  it('strips extra bindings such as Hyperdrive connection strings', () => {
    const config = resolveRuntimeConfig(
      bindings({
        HYPERDRIVE: {
          connectionString: 'postgres://app:secret@db.internal:5432/taxdesk',
        },
      }),
    );
    expect(config).toEqual({ environment: 'development', releaseVersion: '0.0.0' });
    expect(Object.keys(config).sort()).toEqual(['environment', 'releaseVersion']);
  });

  it('rejects a missing or unknown environment', () => {
    expect(() => resolveRuntimeConfig(bindings({ ENVIRONMENT: 'local' as never }))).toThrow();
  });

  it('rejects an empty release version', () => {
    expect(() => resolveRuntimeConfig(bindings({ RELEASE_VERSION: '' }))).toThrow();
  });
});

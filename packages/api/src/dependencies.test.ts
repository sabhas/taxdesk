import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@taxdesk/database';
import type { SqlExecutor } from '@taxdesk/database';

const createSqlExecutor = vi.fn((): SqlExecutor => ({
  query: () => Promise.resolve([]),
  transaction: (work) => work(fakeExecutor()),
  close: () => Promise.resolve(),
}));
function fakeExecutor(): SqlExecutor {
  return createSqlExecutor();
}

vi.mock('@taxdesk/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  createSqlExecutor,
}));

const { createDefaultDependencies, HYPERDRIVE_EXECUTOR_OPTIONS } =
  await import('./dependencies.js');

describe('createDefaultDependencies', () => {
  afterEach(() => {
    createSqlExecutor.mockClear();
  });

  // Hyperdrive does not answer a client TLS handshake: requiring TLS on the
  // Worker side hangs every connection until the connect timeout.
  it.each(['development', 'staging', 'production'] as const)(
    'connects to Hyperdrive without client-side TLS in %s',
    async (environment) => {
      const dependencies = await createDefaultDependencies({
        ENVIRONMENT: environment,
        RELEASE_VERSION: 'test',
        HYPERDRIVE: { connectionString: 'postgres://user:password@hyperdrive.local:5432/db' },
      });

      expect(createSqlExecutor).toHaveBeenCalledWith(
        'postgres://user:password@hyperdrive.local:5432/db',
        HYPERDRIVE_EXECUTOR_OPTIONS,
      );
      expect(HYPERDRIVE_EXECUTOR_OPTIONS.requireTls).toBe(false);
      await dependencies.close();
    },
  );
});

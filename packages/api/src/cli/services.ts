import { createSqlExecutor } from '@taxdesk/database';
import { buildDependencies } from '../dependencies.js';
import { BootstrapService } from '../domain/auth/bootstrap-service.js';
import { RecoveryService } from '../domain/auth/recovery-service.js';

export interface CliServices {
  readonly bootstrap: BootstrapService;
  readonly recovery: RecoveryService;
  readonly close: () => Promise<void>;
}

function requireTls(connectionString: string): boolean {
  return !/[?&]sslmode=disable(?:&|$)/u.test(connectionString);
}

/**
 * Builds the domain services from a deployment database URL. The operator
 * already possesses the database credential; the CLI never accepts an HTTP
 * session and is not exposed by the Worker.
 */
export function createCliServices(
  connectionString: string,
  clock: () => Date = () => new Date(),
): CliServices {
  const executor = createSqlExecutor(connectionString, {
    requireTls: requireTls(connectionString),
    maxConnections: 1,
  });
  const dependencies = buildDependencies({
    executor,
    authConfig: {
      mfaEncryptionKey: undefined,
      turnstileSecretKey: undefined,
      turnstileSiteKey: undefined,
      allowedOrigins: [],
      appPublicUrl: undefined,
    },
    clock,
  });
  return {
    bootstrap: new BootstrapService({
      repositories: dependencies.repositories,
      unitOfWork: dependencies.unitOfWork,
      passwordHasher: dependencies.passwordHasher,
      tokenHasher: dependencies.tokenHasher,
      clock,
    }),
    recovery: new RecoveryService({
      repositories: dependencies.repositories,
      unitOfWork: dependencies.unitOfWork,
      passwordHasher: dependencies.passwordHasher,
      clock,
    }),
    close: dependencies.close,
  };
}

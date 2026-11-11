import { createSqlExecutor, type SqlExecutor } from '@taxdesk/database';
import { createSecretCipher, type SecretCipher } from './crypto/cipher.js';
import { createPasswordHasher, type PasswordHasher } from './crypto/password.js';
import { createTokenHasher, type TokenHasher } from './crypto/token.js';
import { TOTP_DEFAULTS, createTotpService, type TotpService } from './crypto/totp.js';
import {
  createIdentifierProtector,
  type IdentifierProtector,
} from './crypto/identifier-protection.js';
import { AuthService } from './domain/auth/auth-service.js';
import { ClientService } from './domain/clients/client-service.js';
import { FirmService } from './domain/auth/firm-service.js';
import { LoginThrottle } from './domain/auth/login-throttle-service.js';
import { MfaService } from './domain/auth/mfa-service.js';
import { SessionService } from './domain/auth/session-service.js';
import { UserLifecycleService } from './domain/auth/user-lifecycle-service.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './domain/auth/turnstile.js';
import { createPostgresRepositories, createPostgresUnitOfWork } from './repositories/postgres.js';
import type { Repositories, UnitOfWork } from './repositories/ports.js';
import { resolveAuthConfig, type ApiBindings, type AuthRuntimeConfig } from './config.js';

export interface AppDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly authConfig: AuthRuntimeConfig;
  readonly passwordHasher: PasswordHasher;
  readonly tokenHasher: TokenHasher;
  readonly totp: TotpService;
  readonly cipher: SecretCipher | null;
  readonly turnstile: TurnstileVerifier;
  readonly sessionService: SessionService;
  readonly authService: AuthService;
  readonly mfaService: MfaService;
  readonly userService: UserLifecycleService;
  readonly firmService: FirmService;
  readonly clientService: ClientService;
  readonly clock: () => Date;
  readonly close: () => Promise<void>;
}

export class DependencyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyConfigurationError';
  }
}

export interface ComposeDependenciesOptions {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly authConfig: AuthRuntimeConfig;
  readonly clock?: () => Date;
  readonly passwordHasher?: PasswordHasher;
  readonly tokenHasher?: TokenHasher;
  readonly totp?: TotpService;
  readonly cipher?: SecretCipher | null;
  readonly turnstile?: TurnstileVerifier;
  readonly identifiers?: IdentifierProtector | null;
  readonly close?: () => Promise<void>;
}

/**
 * Builds the CNIC/NTN protector from deployment secrets. Without both keys the
 * client routes still read masked data, but any write or exact identifier
 * search that needs them fails with 503 rather than storing plaintext.
 */
export function identifierProtectorFromConfig(
  config: AuthRuntimeConfig,
): IdentifierProtector | null {
  if (
    config.clientDataEncryptionKey === undefined ||
    config.clientIdentifierIndexKey === undefined
  ) {
    return null;
  }
  return createIdentifierProtector({
    encryptionKey: config.clientDataEncryptionKey,
    indexKey: config.clientIdentifierIndexKey,
  });
}

/**
 * Wires domain services and crypto around a repository bundle. Production
 * passes PostgreSQL repositories; tests pass the in-memory bundle.
 */
export function composeDependencies(options: ComposeDependenciesOptions): AppDependencies {
  const clock = options.clock ?? (() => new Date());
  const passwordHasher = options.passwordHasher ?? createPasswordHasher();
  const tokenHasher = options.tokenHasher ?? createTokenHasher();
  const totp = options.totp ?? createTotpService(TOTP_DEFAULTS);
  const cipher =
    options.cipher !== undefined
      ? options.cipher
      : options.authConfig.mfaEncryptionKey === undefined
        ? null
        : createSecretCipher(options.authConfig.mfaEncryptionKey);
  const turnstile =
    options.turnstile ?? createTurnstileVerifier(options.authConfig.turnstileSecretKey);
  const repositories = options.repositories;
  const unitOfWork = options.unitOfWork;
  const throttle = new LoginThrottle(repositories.loginAttempts, tokenHasher, clock);
  const sessionService = new SessionService({
    repositories,
    unitOfWork,
    tokenHasher,
    clock,
  });

  return {
    repositories,
    unitOfWork,
    authConfig: options.authConfig,
    passwordHasher,
    tokenHasher,
    totp,
    cipher,
    turnstile,
    sessionService,
    authService: new AuthService({
      repositories,
      unitOfWork,
      passwordHasher,
      tokenHasher,
      totp,
      cipher,
      throttle,
      sessionService,
      clock,
      turnstile,
      ...(options.authConfig.turnstileSiteKey === undefined
        ? {}
        : { turnstileSiteKey: options.authConfig.turnstileSiteKey }),
    }),
    mfaService: new MfaService({
      repositories,
      unitOfWork,
      passwordHasher,
      tokenHasher,
      totp,
      cipher,
      clock,
    }),
    userService: new UserLifecycleService({
      repositories,
      unitOfWork,
      tokenHasher,
      clock,
    }),
    firmService: new FirmService({ repositories, unitOfWork, clock }),
    clientService: new ClientService({
      repositories,
      unitOfWork,
      identifiers:
        options.identifiers !== undefined
          ? options.identifiers
          : identifierProtectorFromConfig(options.authConfig),
      clock,
    }),
    clock,
    close: options.close ?? (() => Promise.resolve()),
  };
}

export interface BuildDependenciesOptions {
  readonly executor: SqlExecutor;
  readonly authConfig: AuthRuntimeConfig;
  readonly clock?: () => Date;
  readonly passwordHasher?: PasswordHasher;
  readonly tokenHasher?: TokenHasher;
  readonly totp?: TotpService;
  readonly cipher?: SecretCipher | null;
  readonly turnstile?: TurnstileVerifier;
}

export function buildDependencies(options: BuildDependenciesOptions): AppDependencies {
  return composeDependencies({
    repositories: createPostgresRepositories(options.executor),
    unitOfWork: createPostgresUnitOfWork(options.executor),
    authConfig: options.authConfig,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.passwordHasher === undefined ? {} : { passwordHasher: options.passwordHasher }),
    ...(options.tokenHasher === undefined ? {} : { tokenHasher: options.tokenHasher }),
    ...(options.totp === undefined ? {} : { totp: options.totp }),
    ...(options.cipher === undefined ? {} : { cipher: options.cipher }),
    ...(options.turnstile === undefined ? {} : { turnstile: options.turnstile }),
    close: async () => {
      await options.executor.close();
    },
  });
}

/** Default production dependency factory for a Worker request. */
export async function createDefaultDependencies(
  env: ApiBindings,
  clock: () => Date = () => new Date(),
): Promise<AppDependencies> {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new DependencyConfigurationError('The database binding is not configured.');
  }
  // Hyperdrive terminates TLS to the managed database in staging/production.
  // Under `wrangler dev` the binding is a local proxy to a developer Postgres
  // that usually has no TLS, so only the development environment may skip it.
  const executor = createSqlExecutor(connectionString, {
    requireTls: env.ENVIRONMENT !== 'development',
  });
  try {
    return buildDependencies({
      executor,
      authConfig: resolveAuthConfig(env),
      clock,
    });
  } catch (error) {
    await executor.close();
    throw error;
  }
}

export type DependencyFactory = (env: ApiBindings) => Promise<AppDependencies>;

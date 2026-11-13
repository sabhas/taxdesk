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
import { CaseService } from './domain/cases/case-service.js';
import { ServiceTypeService } from './domain/catalog/service-type-service.js';
import { WorkflowTemplateService } from './domain/catalog/workflow-template-service.js';
import { FirmService } from './domain/auth/firm-service.js';
import { LoginThrottle } from './domain/auth/login-throttle-service.js';
import { MfaService } from './domain/auth/mfa-service.js';
import { SessionService } from './domain/auth/session-service.js';
import { UserLifecycleService } from './domain/auth/user-lifecycle-service.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './domain/auth/turnstile.js';
import { StorageConnectionService } from './domain/storage/storage-connection-service.js';
import { DocumentService } from './domain/documents/document-service.js';
import { BillingService } from './domain/billing/billing-service.js';
import { BillingDocumentService } from './domain/billing/billing-documents.js';
import { createPdfRenderer, type PdfRenderer } from './domain/billing/pdf/renderer.js';
import type { StorageGateway } from './storage/gateway.js';
import type { DocumentStorageProvider } from './storage/provider.js';
import { createStorageProviderFromConfig } from './storage/provider-factory.js';
import { DOCUMENT_LIMITS, STORAGE_CALLBACK_PATH } from '@taxdesk/shared';
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
  readonly serviceTypeService: ServiceTypeService;
  readonly workflowTemplateService: WorkflowTemplateService;
  readonly caseService: CaseService;
  readonly storageProvider: DocumentStorageProvider | null;
  readonly storageConnectionService: StorageConnectionService;
  readonly documentService: DocumentService;
  readonly billingService: BillingService;
  readonly billingDocumentService: BillingDocumentService;
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
  /** Overrides the configured storage adapter (tests pass the fake provider). */
  readonly storageProvider?: DocumentStorageProvider | null;
  /** Overrides the storage token cipher (`STORAGE_TOKEN_ENCRYPTION_KEY`). */
  readonly storageCipher?: SecretCipher | null;
  /** Overrides the gateway the document service uses (unit tests only). */
  readonly storageGateway?: StorageGateway;
  /** Overrides the PDF renderer (tests may inject a failing one). */
  readonly pdfRenderer?: PdfRenderer;
  readonly close?: () => Promise<void>;
}

/** The storage token cipher from deployment secrets, or `null` when unset. */
export function storageCipherFromConfig(config: AuthRuntimeConfig): SecretCipher | null {
  return config.storageTokenEncryptionKey === undefined
    ? null
    : createSecretCipher(config.storageTokenEncryptionKey, 1, 'storage token encryption key');
}

/** The provider redirect URI, derived from the public app URL. */
export function storageRedirectUri(config: AuthRuntimeConfig): string | undefined {
  return config.appPublicUrl === undefined
    ? undefined
    : `${config.appPublicUrl.replace(/\/+$/u, '')}${STORAGE_CALLBACK_PATH}`;
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
  const storageProvider =
    options.storageProvider !== undefined
      ? options.storageProvider
      : createStorageProviderFromConfig(options.authConfig);
  const storageCipher =
    options.storageCipher !== undefined
      ? options.storageCipher
      : storageCipherFromConfig(options.authConfig);
  const storageConnectionService = new StorageConnectionService({
    repositories,
    unitOfWork,
    provider: storageProvider,
    cipher: storageCipher,
    tokenHasher,
    clock,
    redirectUri: storageRedirectUri(options.authConfig),
  });
  const documentService = new DocumentService({
    repositories,
    unitOfWork,
    storage: options.storageGateway ?? storageConnectionService,
    cipher: storageCipher,
    clock,
    maxUploadBytes:
      options.authConfig.documentMaxUploadBytes ?? DOCUMENT_LIMITS.defaultMaxUploadBytes,
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
    serviceTypeService: new ServiceTypeService({ repositories, unitOfWork, clock }),
    workflowTemplateService: new WorkflowTemplateService({ repositories, unitOfWork, clock }),
    caseService: new CaseService({ repositories, unitOfWork, clock }),
    storageProvider,
    storageConnectionService,
    documentService,
    billingService: new BillingService({ repositories, unitOfWork, clock }),
    billingDocumentService: new BillingDocumentService({
      repositories,
      unitOfWork,
      storage: options.storageGateway ?? storageConnectionService,
      renderer: options.pdfRenderer ?? createPdfRenderer(),
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

import {
  AUDIT_ACTIONS,
  newUuidV7,
  type StorageAuthorizationResponse,
  type StorageCallbackRequest,
  type StorageCallbackResult,
  type StorageConnection,
  type StorageConnectionStatus,
  type StorageHealthReason,
} from '@taxdesk/shared';
import type { SecretCipher } from '../../crypto/cipher.js';
import type { TokenHasher } from '../../crypto/token.js';
import type { Repositories, UnitOfWork } from '../../repositories/ports.js';
import type {
  StorageAuditContext,
  StorageGateway,
  StorageGatewayStatus,
  StorageOperationContext,
} from '../../storage/gateway.js';
import {
  StorageProviderError,
  type DocumentStorageProvider,
  type ProviderAccount,
  type ProviderCredentials,
} from '../../storage/provider.js';
import { appendAuditEvent } from '../auth/audit-service.js';
import { hasPermission } from '../auth/authorization.js';
import { AuthError } from '../auth/errors.js';
import type { Actor } from '../auth/types.js';
import { personLookup } from '../people.js';
import {
  CredentialVaultError,
  codeChallengeS256,
  decryptCredentials,
  encryptCredentials,
  generateCodeVerifier,
} from './credential-vault.js';
import type { StorageConnectionRecord } from './types.js';

export interface StorageConnectionServiceOptions {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  /** `null` when the deployment has no provider configured. */
  readonly provider: DocumentStorageProvider | null;
  /** Storage token cipher (`STORAGE_TOKEN_ENCRYPTION_KEY`); `null` when unset. */
  readonly cipher: SecretCipher | null;
  readonly tokenHasher: TokenHasher;
  readonly clock: () => Date;
  /** `${APP_PUBLIC_URL}${STORAGE_CALLBACK_PATH}`; `undefined` when APP_PUBLIC_URL is unset. */
  readonly redirectUri: string | undefined;
}

/** How long an administrator has to finish provider consent. */
export const STORAGE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Credentials are refreshed when the access token expires within this window. */
export const STORAGE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const ENTITY_TYPE = 'storage_connection';
const SYSTEM_REQUEST_ID = 'storage-gateway';
/** Fixed message marking a credential refresh failure (no provider text). */
const REFRESH_FAILURE_MARKER = 'The storage credentials could not be refreshed.';

interface Configured {
  readonly provider: DocumentStorageProvider;
  readonly cipher: SecretCipher;
  readonly redirectUri: string;
}

type RefreshOutcome =
  | { readonly kind: 'ok'; readonly credentials: ProviderCredentials }
  | { readonly kind: 'error'; readonly error: StorageProviderError }
  | { readonly kind: 'not_connected' };

function notConfigured(): AuthError {
  return new AuthError(
    503,
    'STORAGE_NOT_CONFIGURED',
    'Document storage is not configured for this deployment.',
  );
}

function notConnected(): AuthError {
  return new AuthError(503, 'STORAGE_NOT_CONNECTED', 'Document storage is not connected.');
}

function reconnectRequired(): AuthError {
  return new AuthError(
    503,
    'STORAGE_RECONNECT_REQUIRED',
    'Document storage needs an administrator to reconnect it.',
  );
}

function unavailable(retryAfterSeconds: number | undefined): AuthError {
  return new AuthError(
    503,
    'STORAGE_UNAVAILABLE',
    'Document storage is temporarily unavailable. Try again shortly.',
    retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
  );
}

/**
 * Storage connection lifecycle (TD-402–TD-404) and the `StorageGateway` the
 * document service uses.
 *
 * - Only `storage.manage` holders (administrators) begin consent, complete the
 *   callback, check health, and disconnect; the routes enforce the
 *   permission and this service binds each OAuth state to the administrator
 *   who started it.
 * - Provider credentials are encrypted at rest with the storage token key and
 *   refreshed under the connection's row lock, so concurrent requests never
 *   race to rotate the refresh token.
 * - A revoked or expired grant marks the connection `reconnect_required`
 *   (audited) and every new document operation stops with 503 until an
 *   administrator reconnects.
 */
export class StorageConnectionService implements StorageGateway {
  private refreshInFlight: Promise<ProviderCredentials> | null = null;

  constructor(private readonly options: StorageConnectionServiceOptions) {}

  private now(): Date {
    return this.options.clock();
  }

  /** Whether provider, token key, and redirect URI are all configured. */
  get configured(): boolean {
    return this.configuration() !== null;
  }

  private configuration(): Configured | null {
    const { provider, cipher, redirectUri } = this.options;
    if (provider === null || cipher === null || redirectUri === undefined) {
      return null;
    }
    return { provider, cipher, redirectUri };
  }

  private requireConfiguration(): Configured {
    const configured = this.configuration();
    if (configured === null) {
      throw notConfigured();
    }
    return configured;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  async view(actor: Actor): Promise<StorageConnection> {
    const record = await this.options.repositories.storageConnections.get();
    return await this.toView(actor, record);
  }

  private async toView(
    actor: Actor,
    record: StorageConnectionRecord | null,
  ): Promise<StorageConnection> {
    const manage = hasPermission(actor, 'storage.manage');
    const configured = this.configured;
    if (record === null) {
      return {
        id: null,
        providerType: null,
        status: 'not_connected',
        healthReason: configured ? null : 'not_configured',
        accountLabel: null,
        connectedAt: null,
        connectedByName: null,
        lastCheckedAt: null,
        lastRefreshedAt: null,
        version: null,
        configured,
        permissions: { manage },
      };
    }
    const lookup = personLookup(this.options.repositories.users);
    const connectedBy = manage ? await lookup(record.connectedBy) : null;
    const connected = record.status !== 'not_connected';
    return {
      id: record.id,
      providerType: record.providerType,
      status: record.status,
      healthReason: !configured ? 'not_configured' : record.healthReason,
      // Account details are shown to administrators only.
      accountLabel: manage && connected ? record.accountLabel : null,
      connectedAt: connected ? record.connectedAt : null,
      connectedByName: connected ? (connectedBy?.displayName ?? null) : null,
      lastCheckedAt: record.lastCheckedAt,
      lastRefreshedAt: record.lastRefreshedAt,
      version: record.version,
      configured,
      permissions: { manage },
    };
  }

  // -------------------------------------------------------------------------
  // Consent (TD-403)
  // -------------------------------------------------------------------------

  async beginAuthorization(input: {
    readonly actorUserId: string;
    readonly requestId: string;
  }): Promise<StorageAuthorizationResponse> {
    const { provider, cipher, redirectUri } = this.requireConfiguration();
    const now = this.now();
    const state = this.options.tokenHasher.generate(32);
    const verifier = generateCodeVerifier();
    const challenge = await codeChallengeS256(verifier);
    const expiresAt = new Date(now.getTime() + STORAGE_OAUTH_STATE_TTL_MS).toISOString();
    const { authorizationUrl } = provider.beginConnection({
      state,
      codeChallenge: challenge,
      redirectUri,
    });
    const stateHash = await this.options.tokenHasher.hash(state);
    const verifierCiphertext = await cipher.encrypt(verifier);

    await this.options.unitOfWork.run(async (repositories) => {
      await repositories.storageOAuthStates.pruneBefore(
        new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      );
      await repositories.storageOAuthStates.create({
        id: newUuidV7(now.getTime()),
        stateHash,
        codeVerifierCiphertext: verifierCiphertext,
        keyVersion: cipher.keyVersion,
        providerType: provider.providerType,
        createdBy: input.actorUserId,
        createdAt: now.toISOString(),
        expiresAt,
        consumedAt: null,
      });
      const existing = await repositories.storageConnections.get();
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actorUserId,
        action: AUDIT_ACTIONS.storageConnectionStarted,
        entityType: ENTITY_TYPE,
        entityId: existing?.id ?? null,
        requestId: input.requestId,
        metadata: { providerType: provider.providerType },
      });
    });

    return { authorizationUrl, expiresAt };
  }

  /**
   * Completes consent from the provider callback. Never throws for an
   * expected failure: the result code is shown on the settings page. Provider
   * error text is never echoed or stored.
   */
  async completeAuthorization(input: {
    readonly actorUserId: string;
    readonly requestId: string;
    readonly request: StorageCallbackRequest;
  }): Promise<StorageCallbackResult> {
    const configured = this.configuration();
    if (configured === null) {
      await this.auditFailure(input, 'not_configured');
      return 'failed';
    }
    const { provider, cipher, redirectUri } = configured;
    const now = this.now();

    const state = input.request.state;
    if (state === undefined || state.length === 0) {
      await this.auditFailure(input, 'invalid_state');
      return 'invalid_state';
    }
    const stateHash = await this.options.tokenHasher.hash(state);
    const record = await this.options.repositories.storageOAuthStates.findByStateHash(stateHash);
    // Bound to the administrator who started consent, and to this provider.
    if (record?.createdBy !== input.actorUserId || record.providerType !== provider.providerType) {
      await this.auditFailure(input, 'invalid_state');
      return 'invalid_state';
    }
    // Single use: consume before anything else, so a replay always fails.
    const consumed = await this.options.repositories.storageOAuthStates.consume(
      record.id,
      now.toISOString(),
    );
    if (!consumed) {
      await this.auditFailure(input, 'invalid_state');
      return 'invalid_state';
    }
    if (record.expiresAt <= now.toISOString()) {
      await this.auditFailure(input, 'expired');
      return 'expired';
    }
    if (input.request.error !== undefined) {
      const denied = input.request.error === 'access_denied';
      await this.auditFailure(input, denied ? 'denied' : 'provider_error');
      return denied ? 'denied' : 'failed';
    }
    const code = input.request.code;
    if (code === undefined || code.length === 0) {
      await this.auditFailure(input, 'missing_code');
      return 'failed';
    }

    let verifier: string;
    try {
      if (record.keyVersion !== cipher.keyVersion) {
        throw new Error('key version');
      }
      verifier = await cipher.decrypt(record.codeVerifierCiphertext);
    } catch {
      await this.auditFailure(input, 'state_unreadable');
      return 'failed';
    }

    let grant;
    try {
      grant = await provider.completeConnection({ code, codeVerifier: verifier, redirectUri });
    } catch (error) {
      const reason = error instanceof StorageProviderError ? error.kind : 'provider_error';
      await this.auditFailure(input, reason);
      return 'failed';
    }

    const encrypted = await encryptCredentials(cipher, grant.credentials);
    const save = () =>
      this.options.unitOfWork.run(async (repositories) => {
        const existing = await repositories.storageConnections.lock();
        const at = now.toISOString();
        const fields = {
          providerType: provider.providerType,
          status: 'healthy' as const,
          healthReason: null,
          externalDriveId: grant.account.driveId,
          externalRootFolderId: grant.account.rootFolderId,
          accountLabel: grant.account.accountLabel,
          tokenCiphertext: encrypted.ciphertext,
          tokenKeyVersion: encrypted.keyVersion,
          accessTokenExpiresAt: grant.credentials.accessTokenExpiresAt,
          connectedAt: at,
          connectedBy: input.actorUserId,
          lastCheckedAt: at,
          lastRefreshedAt: null,
          disconnectedAt: null,
          disconnectedBy: null,
        };
        let id: string;
        let reconnect = false;
        if (existing === null) {
          id = newUuidV7(now.getTime());
          await repositories.storageConnections.create({
            id,
            ...fields,
            createdAt: at,
            updatedAt: at,
            version: 1,
          });
        } else {
          id = existing.id;
          reconnect = existing.status !== 'not_connected';
          const updated = await repositories.storageConnections.update({
            id: existing.id,
            changes: fields,
            expectedVersion: existing.version,
            at,
          });
          if (updated === null) {
            throw new AuthError(409, 'CONFLICT', 'The storage connection changed. Try again.');
          }
        }
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: input.actorUserId,
          action: reconnect ? AUDIT_ACTIONS.storageReconnected : AUDIT_ACTIONS.storageConnected,
          entityType: ENTITY_TYPE,
          entityId: id,
          requestId: input.requestId,
          metadata: { providerType: provider.providerType },
        });
      });
    try {
      await save();
    } catch (error) {
      // Two first-time completions raced and the other inserted the singleton
      // row (unique violation). The failed transaction rolled back; retry once,
      // which now finds the row under the lock and updates it.
      if (
        error instanceof AuthError ||
        (await this.options.repositories.storageConnections.get()) === null
      ) {
        throw error;
      }
      await save();
    }
    return 'connected';
  }

  private async auditFailure(
    input: { readonly actorUserId: string; readonly requestId: string },
    reason: string,
  ): Promise<void> {
    const existing = await this.options.repositories.storageConnections.get();
    await appendAuditEvent(this.options.repositories.audit, this.now(), {
      actorUserId: input.actorUserId,
      action: AUDIT_ACTIONS.storageConnectionFailed,
      entityType: ENTITY_TYPE,
      entityId: existing?.id ?? null,
      requestId: input.requestId,
      metadata: { reason },
    });
  }

  // -------------------------------------------------------------------------
  // Health check and disconnect (TD-403, TD-404)
  // -------------------------------------------------------------------------

  async check(input: {
    readonly actor: Actor;
    readonly requestId: string;
  }): Promise<StorageConnection> {
    const { provider, cipher } = this.requireConfiguration();
    const audit: StorageAuditContext = {
      requestId: input.requestId,
      actorUserId: input.actor.userId,
    };
    const record = await this.options.repositories.storageConnections.get();
    if (record === null || record.status === 'not_connected' || record.tokenCiphertext === null) {
      throw notConnected();
    }

    let credentials: ProviderCredentials;
    try {
      credentials = await decryptCredentials(
        cipher,
        record.tokenCiphertext,
        record.tokenKeyVersion ?? 0,
      );
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) {
        throw error;
      }
      await this.markStatus('reconnect_required', 'refresh_failed', audit, null);
      return await this.view(input.actor);
    }

    const outcome = await this.checkWith(provider, credentials, audit);
    if (outcome !== null) {
      await this.markStatus(outcome.status, outcome.reason, audit, null);
    }
    return await this.view(input.actor);
  }

  /**
   * Runs a health check, refreshing once when needed. Returns the unhealthy
   * status to record, or `null` after recording a healthy result.
   */
  private async checkWith(
    provider: DocumentStorageProvider,
    initial: ProviderCredentials,
    audit: StorageAuditContext,
  ): Promise<{ status: StorageConnectionStatus; reason: StorageHealthReason } | null> {
    let credentials = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (attempt > 0 || this.expiring(credentials)) {
          credentials = await this.refreshShared(credentials.accessToken);
        }
      } catch (error) {
        if (error instanceof StorageProviderError) {
          return this.statusFor(error, true);
        }
        throw error;
      }
      const health = await provider.checkHealth(credentials);
      if (health.kind === 'healthy') {
        await this.markStatus('healthy', null, audit, health.account);
        return null;
      }
      if (health.error.kind !== 'unauthorized' || attempt > 0) {
        return this.statusFor(health.error, false);
      }
    }
    return { status: 'reconnect_required', reason: 'consent_revoked' };
  }

  async disconnect(input: {
    readonly actor: Actor;
    readonly requestId: string;
    readonly expectedVersion: number;
  }): Promise<StorageConnection> {
    const now = this.now();
    const record = await this.options.unitOfWork.run(async (repositories) => {
      const existing = await repositories.storageConnections.lock();
      if (existing === null || existing.status === 'not_connected') {
        throw new AuthError(409, 'STORAGE_NOT_CONNECTED', 'Document storage is not connected.');
      }
      if (existing.version !== input.expectedVersion) {
        throw new AuthError(
          412,
          'PRECONDITION_FAILED',
          'The storage connection changed. Refresh and review it before disconnecting.',
        );
      }
      const at = now.toISOString();
      const updated = await repositories.storageConnections.update({
        id: existing.id,
        changes: {
          status: 'not_connected',
          healthReason: null,
          tokenCiphertext: null,
          tokenKeyVersion: null,
          accessTokenExpiresAt: null,
          disconnectedAt: at,
          disconnectedBy: input.actor.userId,
        },
        expectedVersion: existing.version,
        at,
      });
      if (updated === null) {
        throw new AuthError(
          412,
          'PRECONDITION_FAILED',
          'The storage connection changed. Refresh and review it before disconnecting.',
        );
      }
      await appendAuditEvent(repositories.audit, now, {
        actorUserId: input.actor.userId,
        action: AUDIT_ACTIONS.storageDisconnected,
        entityType: ENTITY_TYPE,
        entityId: existing.id,
        requestId: input.requestId,
        metadata: { providerType: existing.providerType, previousStatus: existing.status },
      });
      return updated;
    });
    return await this.toView(input.actor, record);
  }

  // -------------------------------------------------------------------------
  // StorageGateway (TD-404)
  // -------------------------------------------------------------------------

  async currentStatus(): Promise<StorageGatewayStatus> {
    const record = await this.options.repositories.storageConnections.get();
    if (record === null) {
      return { status: 'not_connected', providerType: null };
    }
    return { status: record.status, providerType: record.providerType };
  }

  async run<T>(
    operation: (context: StorageOperationContext) => Promise<T>,
    audit: StorageAuditContext = {},
  ): Promise<T> {
    const { provider, cipher } = this.requireConfiguration();
    const record = await this.requireUsable();
    let credentials: ProviderCredentials;
    try {
      credentials = await decryptCredentials(
        cipher,
        record.tokenCiphertext ?? '',
        record.tokenKeyVersion ?? 0,
      );
    } catch (error) {
      if (error instanceof CredentialVaultError) {
        await this.markStatus('reconnect_required', 'refresh_failed', audit, null);
        throw reconnectRequired();
      }
      throw error;
    }
    const account: ProviderAccount = {
      driveId: record.externalDriveId,
      rootFolderId: record.externalRootFolderId ?? '',
      accountLabel: record.accountLabel,
    };

    for (let attempt = 0; ; attempt += 1) {
      try {
        if (attempt > 0 || this.expiring(credentials)) {
          credentials = await this.refreshShared(credentials.accessToken);
        }
        const result = await operation({
          provider,
          credentials,
          account,
          providerType: provider.providerType,
        });
        if (record.status !== 'healthy') {
          await this.markStatus('healthy', null, audit, null);
        }
        return result;
      } catch (error) {
        if (!(error instanceof StorageProviderError)) {
          throw error;
        }
        if (error.kind === 'unauthorized' && attempt === 0) {
          continue; // refresh once and retry
        }
        throw await this.failWith(error, audit, attempt > 0 && error.kind === 'unauthorized');
      }
    }
  }

  async runWithoutCredentials<T>(
    operation: (provider: DocumentStorageProvider) => Promise<T>,
    audit: StorageAuditContext = {},
  ): Promise<T> {
    const { provider } = this.requireConfiguration();
    const record = await this.requireUsable();
    try {
      const result = await operation(provider);
      if (record.status !== 'healthy') {
        await this.markStatus('healthy', null, audit, null);
      }
      return result;
    } catch (error) {
      if (!(error instanceof StorageProviderError)) {
        throw error;
      }
      throw await this.failWith(error, audit, false);
    }
  }

  /** Status precondition: `healthy` runs; `unavailable` may run to recover. */
  private async requireUsable(): Promise<StorageConnectionRecord> {
    const record = await this.options.repositories.storageConnections.get();
    if (record === null || record.status === 'not_connected' || record.tokenCiphertext === null) {
      throw notConnected();
    }
    if (record.status === 'reconnect_required') {
      throw reconnectRequired();
    }
    return record;
  }

  private expiring(credentials: ProviderCredentials): boolean {
    return (
      Date.parse(credentials.accessTokenExpiresAt) - this.now().getTime() <=
      STORAGE_REFRESH_WINDOW_MS
    );
  }

  private statusFor(
    error: StorageProviderError,
    duringRefresh: boolean,
  ): { status: StorageConnectionStatus; reason: StorageHealthReason } {
    switch (error.kind) {
      case 'reconnect_required':
      case 'unauthorized':
        return {
          status: 'reconnect_required',
          reason: duringRefresh ? 'refresh_failed' : 'consent_revoked',
        };
      case 'rate_limited':
        return { status: 'unavailable', reason: 'rate_limited' };
      case 'not_found':
        return { status: 'unavailable', reason: 'folder_unavailable' };
      default:
        return { status: 'unavailable', reason: 'provider_unavailable' };
    }
  }

  /**
   * Maps a provider failure: health-affecting kinds update the connection and
   * become a 503; item-level kinds are returned unchanged for the caller.
   */
  private async failWith(
    error: StorageProviderError,
    audit: StorageAuditContext,
    unauthorizedAfterRefresh: boolean,
  ): Promise<Error> {
    const fromRefresh = error.message === REFRESH_FAILURE_MARKER;
    switch (error.kind) {
      case 'reconnect_required':
        await this.markStatus(
          'reconnect_required',
          fromRefresh ? 'refresh_failed' : 'consent_revoked',
          audit,
          null,
        );
        return reconnectRequired();
      case 'unauthorized':
        if (unauthorizedAfterRefresh || fromRefresh) {
          await this.markStatus('reconnect_required', 'consent_revoked', audit, null);
          return reconnectRequired();
        }
        return error;
      case 'unavailable':
        await this.markStatus('unavailable', 'provider_unavailable', audit, null);
        return unavailable(error.retryAfterSeconds);
      case 'rate_limited':
        await this.markStatus('unavailable', 'rate_limited', audit, null);
        return unavailable(error.retryAfterSeconds);
      case 'not_configured':
        return notConfigured();
      default:
        return error;
    }
  }

  /**
   * Shares one refresh between concurrent callers in this process; the row
   * lock serializes refreshes across processes.
   */
  private refreshShared(staleAccessToken: string): Promise<ProviderCredentials> {
    if (this.refreshInFlight !== null) {
      return this.refreshInFlight;
    }
    const pending = this.refreshLocked(staleAccessToken).finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  private async refreshLocked(staleAccessToken: string): Promise<ProviderCredentials> {
    const { provider, cipher } = this.requireConfiguration();
    const now = this.now();
    const outcome = await this.options.unitOfWork.run(
      async (repositories): Promise<RefreshOutcome> => {
        const locked = await repositories.storageConnections.lock();
        if (
          locked === null ||
          locked.status === 'not_connected' ||
          locked.tokenCiphertext === null ||
          locked.tokenKeyVersion === null
        ) {
          return { kind: 'not_connected' };
        }
        let current: ProviderCredentials;
        try {
          current = await decryptCredentials(
            cipher,
            locked.tokenCiphertext,
            locked.tokenKeyVersion,
          );
        } catch {
          return {
            kind: 'error',
            error: new StorageProviderError('reconnect_required', REFRESH_FAILURE_MARKER),
          };
        }
        // Another request refreshed while this one waited for the lock.
        if (current.accessToken !== staleAccessToken && !this.expiring(current)) {
          return { kind: 'ok', credentials: current };
        }
        let next: ProviderCredentials;
        try {
          next = await provider.refreshCredentials(current);
        } catch (error) {
          if (error instanceof StorageProviderError) {
            return {
              kind: 'error',
              error:
                error.kind === 'reconnect_required' || error.kind === 'unauthorized'
                  ? new StorageProviderError('reconnect_required', REFRESH_FAILURE_MARKER)
                  : error,
            };
          }
          throw error;
        }
        const encrypted = await encryptCredentials(cipher, next);
        const at = now.toISOString();
        const updated = await repositories.storageConnections.update({
          id: locked.id,
          changes: {
            tokenCiphertext: encrypted.ciphertext,
            tokenKeyVersion: encrypted.keyVersion,
            accessTokenExpiresAt: next.accessTokenExpiresAt,
            lastRefreshedAt: at,
          },
          expectedVersion: locked.version,
          at,
        });
        if (updated === null) {
          return {
            kind: 'error',
            error: new StorageProviderError(
              'unavailable',
              'The connection changed during refresh.',
            ),
          };
        }
        return { kind: 'ok', credentials: next };
      },
    );
    if (outcome.kind === 'not_connected') {
      throw notConnected();
    }
    if (outcome.kind === 'error') {
      throw outcome.error;
    }
    return outcome.credentials;
  }

  /**
   * Records a health status. Audits `storage.health_changed` only when the
   * status actually changes. Never touches a disconnected connection.
   */
  private async markStatus(
    status: StorageConnectionStatus,
    reason: StorageHealthReason | null,
    audit: StorageAuditContext,
    account: ProviderAccount | null,
  ): Promise<void> {
    const now = this.now();
    await this.options.unitOfWork.run(async (repositories) => {
      const locked = await repositories.storageConnections.lock();
      if (locked === null || locked.status === 'not_connected') {
        return;
      }
      // Re-checked under the lock: a success never clears a concurrently
      // recorded reconnect-required state; only an administrator's reconnect does.
      if (status === 'healthy' && locked.status === 'reconnect_required') {
        return;
      }
      const at = now.toISOString();
      await repositories.storageConnections.update({
        id: locked.id,
        changes: {
          status,
          healthReason: reason,
          lastCheckedAt: at,
          ...(account === null
            ? {}
            : {
                externalDriveId: account.driveId,
                externalRootFolderId: account.rootFolderId,
                accountLabel: account.accountLabel,
              }),
        },
        expectedVersion: locked.version,
        at,
      });
      if (locked.status !== status) {
        await appendAuditEvent(repositories.audit, now, {
          actorUserId: audit.actorUserId ?? null,
          action: AUDIT_ACTIONS.storageHealthChanged,
          entityType: ENTITY_TYPE,
          entityId: locked.id,
          requestId: audit.requestId ?? SYSTEM_REQUEST_ID,
          metadata: { from: locked.status, to: status, reason },
        });
      }
    });
  }
}

import { DeploymentEnvironmentSchema, type DeploymentEnvironment } from '@taxdesk/shared';
import { z } from 'zod';

/**
 * Bindings supplied to the Worker by Wrangler. Non-secret values arrive from
 * `[vars]`; Hyperdrive supplies the pooled database connection string. Secret
 * values are never read by the health endpoint and are not part of this shape.
 */
export interface ApiBindings {
  ENVIRONMENT: DeploymentEnvironment;
  RELEASE_VERSION: string;
  HYPERDRIVE?: {
    connectionString: string;
  };
  MFA_ENCRYPTION_KEY?: string;
  CLIENT_DATA_ENCRYPTION_KEY?: string;
  CLIENT_IDENTIFIER_INDEX_KEY?: string;
  STORAGE_TOKEN_ENCRYPTION_KEY?: string;
  ONEDRIVE_CLIENT_ID?: string;
  ONEDRIVE_CLIENT_SECRET?: string;
  ONEDRIVE_AUTHORITY?: string;
  DOCUMENT_MAX_UPLOAD_BYTES?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  APP_ORIGIN?: string;
  APP_PUBLIC_URL?: string;
  [key: string]: unknown;
}

const RuntimeConfigSchema = z.object({
  ENVIRONMENT: DeploymentEnvironmentSchema,
  RELEASE_VERSION: z.string().min(1),
});

export interface RuntimeConfig {
  environment: DeploymentEnvironment;
  releaseVersion: string;
}

/**
 * Validates the deployment configuration required to serve the API. Extra
 * bindings (for example `HYPERDRIVE`) are allowed but stripped, so downstream
 * code can only consume the environment and release version.
 */
export function resolveRuntimeConfig(env: ApiBindings): RuntimeConfig {
  const parsed = RuntimeConfigSchema.parse(env);
  return {
    environment: parsed.ENVIRONMENT,
    releaseVersion: parsed.RELEASE_VERSION,
  };
}

export interface AuthRuntimeConfig {
  readonly mfaEncryptionKey: string | undefined;
  readonly turnstileSecretKey: string | undefined;
  readonly turnstileSiteKey: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly appPublicUrl: string | undefined;
  /** AES-256-GCM key for client CNIC/NTN ciphertext. */
  readonly clientDataEncryptionKey?: string | undefined;
  /** HMAC key for the client identifier blind index. */
  readonly clientIdentifierIndexKey?: string | undefined;
  /** AES-256-GCM key for storage provider tokens and upload-session handles. */
  readonly storageTokenEncryptionKey?: string | undefined;
  /** Microsoft application (client) ID for the OneDrive adapter. */
  readonly onedriveClientId?: string | undefined;
  /** Optional client secret when the app registration is a confidential web app. */
  readonly onedriveClientSecret?: string | undefined;
  /** Microsoft identity authority tenant segment; defaults to `consumers`. */
  readonly onedriveAuthority?: string | undefined;
  /** Maximum upload size in bytes; defaults to 250 MiB. */
  readonly documentMaxUploadBytes?: number | undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const raw = optionalString(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Identity/MFA configuration. Missing MFA and Turnstile secrets are surfaced as
 * explicit service-unavailable responses at the point of use; they never
 * silently disable a required security control.
 */
export function resolveAuthConfig(env: ApiBindings): AuthRuntimeConfig {
  const allowedOrigins = (optionalString(env.APP_ORIGIN) ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    mfaEncryptionKey: optionalString(env.MFA_ENCRYPTION_KEY),
    turnstileSecretKey: optionalString(env.TURNSTILE_SECRET_KEY),
    turnstileSiteKey: optionalString(env.TURNSTILE_SITE_KEY),
    allowedOrigins,
    appPublicUrl: optionalString(env.APP_PUBLIC_URL),
    clientDataEncryptionKey: optionalString(env.CLIENT_DATA_ENCRYPTION_KEY),
    clientIdentifierIndexKey: optionalString(env.CLIENT_IDENTIFIER_INDEX_KEY),
    storageTokenEncryptionKey: optionalString(env.STORAGE_TOKEN_ENCRYPTION_KEY),
    onedriveClientId: optionalString(env.ONEDRIVE_CLIENT_ID),
    onedriveClientSecret: optionalString(env.ONEDRIVE_CLIENT_SECRET),
    onedriveAuthority: optionalString(env.ONEDRIVE_AUTHORITY),
    documentMaxUploadBytes: optionalPositiveInteger(env.DOCUMENT_MAX_UPLOAD_BYTES),
  };
}

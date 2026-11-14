import { z } from 'zod';
import type { SecretCipher } from '../../crypto/cipher.js';
import { bytesToBase64Url, randomBytes } from '../../crypto/encoding.js';
import type { ProviderCredentials } from '../../storage/provider.js';

/**
 * Encryption at rest for provider credentials (TD-402). The whole credential
 * bundle — access token, refresh token, expiry, scopes — is one AES-256-GCM
 * ciphertext keyed by `STORAGE_TOKEN_ENCRYPTION_KEY`, stored next to the key
 * version that wrote it. Plaintext credentials exist only in memory for one
 * provider call and are never logged, audited, or returned.
 */

const StoredCredentialsSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    accessTokenExpiresAt: z.iso.datetime(),
    scopes: z.array(z.string()),
  })
  .strict();

export interface EncryptedCredentials {
  readonly ciphertext: string;
  readonly keyVersion: number;
}

export class CredentialVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialVaultError';
  }
}

export async function encryptCredentials(
  cipher: SecretCipher,
  credentials: ProviderCredentials,
): Promise<EncryptedCredentials> {
  const payload = JSON.stringify({
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    scopes: [...credentials.scopes],
  });
  return { ciphertext: await cipher.encrypt(payload), keyVersion: cipher.keyVersion };
}

/** Throws `CredentialVaultError` when the ciphertext is unreadable (wrong key, tampered). */
export async function decryptCredentials(
  cipher: SecretCipher,
  ciphertext: string,
  keyVersion: number,
): Promise<ProviderCredentials> {
  if (keyVersion !== cipher.keyVersion) {
    throw new CredentialVaultError('The stored credentials use a different key version.');
  }
  let plaintext: string;
  try {
    plaintext = await cipher.decrypt(ciphertext);
  } catch {
    throw new CredentialVaultError('The stored credentials could not be decrypted.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new CredentialVaultError('The stored credentials are malformed.');
  }
  const parsed = StoredCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CredentialVaultError('The stored credentials are malformed.');
  }
  return parsed.data;
}

/** RFC 7636 code verifier: 32 random bytes, base64url (43 characters). */
export function generateCodeVerifier(): string {
  return bytesToBase64Url(randomBytes(32));
}

/** RFC 7636 S256 code challenge for a verifier. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

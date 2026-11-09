import { base64UrlToBytes, bytesToBase64Url, randomBytes } from './encoding.js';

export interface SecretCipher {
  readonly keyVersion: number;
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export class SecretCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretCipherError';
  }
}

const IV_BYTES = 12;

/**
 * AES-256-GCM for short deployment secrets such as TOTP shared secrets. The
 * key lives in deployment secrets and never in the database. Ciphertext is
 * self-describing (`v<keyVersion>.<iv>.<ciphertext>`) so a future key rotation
 * can decrypt old values while writing the new version.
 */
export function createSecretCipher(base64Key: string, keyVersion = 1): SecretCipher {
  const rawKey = base64UrlToBytes(base64Key);
  if (rawKey.length !== 32) {
    throw new SecretCipherError('The MFA encryption key must be 32 bytes of base64url data.');
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new SecretCipherError('The MFA encryption key version must be a positive integer.');
  }

  const importKey = async (): Promise<CryptoKey> =>
    await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);

  return {
    keyVersion,
    async encrypt(plaintext: string): Promise<string> {
      const iv = randomBytes(IV_BYTES);
      const key = await importKey();
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        new TextEncoder().encode(plaintext),
      );
      return `v${String(keyVersion)}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
    },
    async decrypt(value: string): Promise<string> {
      const [versionPart, ivPart, ciphertextPart] = value.split('.');
      if (versionPart === undefined || ivPart === undefined || ciphertextPart === undefined) {
        throw new SecretCipherError('The encrypted secret is malformed.');
      }
      const version = Number(versionPart.replace(/^v/u, ''));
      if (!Number.isInteger(version) || version < 1) {
        throw new SecretCipherError('The encrypted secret has an invalid key version.');
      }
      if (version !== keyVersion) {
        throw new SecretCipherError('The encrypted secret uses a different key version.');
      }
      const key = await importKey();
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64UrlToBytes(ivPart) as BufferSource },
          key,
          base64UrlToBytes(ciphertextPart),
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        throw new SecretCipherError('The encrypted secret could not be decrypted.');
      }
    },
  };
}

/** Generates a base64url 32-byte key for `.dev.vars` or `wrangler secret put`. */
export function generateSecretCipherKey(): string {
  return bytesToBase64Url(randomBytes(32));
}

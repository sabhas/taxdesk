import { formatCnic, formatNtn, maskIdentifier } from '@taxdesk/shared';
import { createSecretCipher, type SecretCipher } from './cipher.js';
import { base64UrlToBytes, bytesToHex } from './encoding.js';

export type IdentifierKind = 'cnic' | 'ntn';

/** How a national identifier is persisted. The plaintext is never stored. */
export interface ProtectedIdentifier {
  /** AES-256-GCM ciphertext (`v<key>.<iv>.<data>`) for future authorized use. */
  readonly ciphertext: string;
  /** HMAC-SHA-256 hex digest for exact duplicate blocking and exact search. */
  readonly blindIndex: string;
  /** Display form keeping only the last four digits. */
  readonly masked: string;
}

export interface IdentifierProtector {
  readonly keyVersion: number;
  /** `digits` must already be normalized by the shared contract. */
  protect(kind: IdentifierKind, digits: string): Promise<ProtectedIdentifier>;
  blindIndex(kind: IdentifierKind, digits: string): Promise<string>;
}

export class IdentifierProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierProtectionError';
  }
}

export interface IdentifierProtectionKeys {
  /** base64url 32-byte AES-256-GCM key (`CLIENT_DATA_ENCRYPTION_KEY`). */
  readonly encryptionKey: string;
  /** base64url 32-byte HMAC key (`CLIENT_IDENTIFIER_INDEX_KEY`). */
  readonly indexKey: string;
  readonly keyVersion?: number;
}

export function formatIdentifier(kind: IdentifierKind, digits: string): string {
  return kind === 'cnic' ? formatCnic(digits) : formatNtn(digits);
}

/**
 * Protects CNIC/NTN values. Encryption and the blind index use separate keys,
 * so the index key can match duplicates without being able to decrypt, and a
 * leaked index cannot be reversed without the HMAC key. The kind is part of
 * the HMAC input, so a CNIC and an NTN with the same digits index differently.
 */
export function createIdentifierProtector(keys: IdentifierProtectionKeys): IdentifierProtector {
  const keyVersion = keys.keyVersion ?? 1;
  const cipher: SecretCipher = createSecretCipher(
    keys.encryptionKey,
    keyVersion,
    'client data encryption key',
  );
  let rawIndexKey: Uint8Array;
  try {
    rawIndexKey = base64UrlToBytes(keys.indexKey);
  } catch {
    rawIndexKey = new Uint8Array(0);
  }
  if (rawIndexKey.length !== 32) {
    throw new IdentifierProtectionError(
      'The client identifier index key must be 32 bytes of base64url data.',
    );
  }
  if (keys.indexKey === keys.encryptionKey) {
    throw new IdentifierProtectionError(
      'The client identifier index key must differ from the encryption key.',
    );
  }
  let hmacKey: Promise<CryptoKey> | null = null;
  const importHmacKey = (): Promise<CryptoKey> => {
    hmacKey ??= crypto.subtle.importKey(
      'raw',
      rawIndexKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return hmacKey;
  };

  const blindIndex = async (kind: IdentifierKind, digits: string): Promise<string> => {
    const signature = await crypto.subtle.sign(
      'HMAC',
      await importHmacKey(),
      new TextEncoder().encode(`taxdesk.client.${kind}:${digits}`),
    );
    return bytesToHex(new Uint8Array(signature));
  };

  return {
    keyVersion,
    blindIndex,
    async protect(kind, digits) {
      return {
        ciphertext: await cipher.encrypt(digits),
        blindIndex: await blindIndex(kind, digits),
        masked: maskIdentifier(formatIdentifier(kind, digits)),
      };
    },
  };
}

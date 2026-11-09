import { randomBytes } from '../../crypto/encoding.js';
import { base32Encode } from '../../crypto/totp.js';

const GROUP_SIZE = 4;

/**
 * Generates a high-entropy, human-transcribable recovery code. Ten random
 * bytes become 16 base32 characters (80 bits); presentation groups them for
 * readability. Only the normalized form's SHA-256 hash is stored.
 */
export function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(10));
  return raw.match(new RegExp(`.{1,${String(GROUP_SIZE)}}`, 'gu'))?.join('-') ?? raw;
}

export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z2-7]/gu, '');
}

import { base64UrlToBytes, bytesToBase64Url, randomBytes } from './encoding.js';
import { timingSafeEqualHex } from './token.js';

export interface PasswordHashParameters {
  readonly version: number;
  readonly iterations: number;
  readonly saltBytes: number;
  readonly hashBytes: number;
}

/**
 * Cloudflare Workers' Web Crypto rejects PBKDF2 above 100,000 iterations
 * (`NotSupportedError`). Node accepts more, so a hash created by the offline
 * CLI with a higher count would verify in tests but make every sign-in fail on
 * the deployed Worker. Both hashing and verification are capped here.
 */
export const MAX_PBKDF2_ITERATIONS = 100_000;

/**
 * PBKDF2-HMAC-SHA-256 work factor, set to the Workers runtime maximum. The
 * parameters are encoded in every hash so a future version can change the work
 * factor (or algorithm) without invalidating existing credentials;
 * verification uses the encoded parameters, and login reports that a rehash is
 * due.
 */
export const PASSWORD_HASH_V1: PasswordHashParameters = {
  version: 1,
  iterations: MAX_PBKDF2_ITERATIONS,
  saltBytes: 16,
  hashBytes: 32,
};

export interface PasswordVerification {
  readonly valid: boolean;
  readonly needsRehash: boolean;
}

export interface PasswordHasher {
  readonly currentParameters: PasswordHashParameters;
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string | null): Promise<PasswordVerification>;
}

const HASH_PREFIX = 'pbkdf2-sha256';

function parseHash(encoded: string): {
  parameters: PasswordHashParameters;
  salt: Uint8Array;
  digest: Uint8Array;
} | null {
  const parts = encoded.split('$');
  if (parts.length !== 5 || parts[0] !== HASH_PREFIX) {
    return null;
  }
  const version = Number(parts[1]);
  const iterations = Number(parts[2]);
  if (!Number.isInteger(version) || version < 1) {
    return null;
  }
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > MAX_PBKDF2_ITERATIONS) {
    // Fail closed as an invalid credential rather than throwing from the
    // runtime; the offline recovery CLI resets an unusable hash.
    return null;
  }
  try {
    const salt = base64UrlToBytes(parts[3] ?? '');
    const digest = base64UrlToBytes(parts[4] ?? '');
    if (salt.length < 8 || digest.length < 16) {
      return null;
    }
    return {
      parameters: {
        version,
        iterations,
        saltBytes: salt.length,
        hashBytes: digest.length,
      },
      salt,
      digest,
    };
  } catch {
    return null;
  }
}

async function derive(
  password: string,
  salt: Uint8Array,
  parameters: PasswordHashParameters,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: parameters.iterations,
    },
    key,
    parameters.hashBytes * 8,
  );
  return new Uint8Array(bits);
}

export function createPasswordHasher(
  currentParameters: PasswordHashParameters = PASSWORD_HASH_V1,
): PasswordHasher {
  if (currentParameters.iterations > MAX_PBKDF2_ITERATIONS) {
    throw new RangeError(
      `PBKDF2 iterations above ${String(MAX_PBKDF2_ITERATIONS)} are not supported by the Workers runtime.`,
    );
  }
  return {
    currentParameters,
    async hash(password: string): Promise<string> {
      const salt = randomBytes(currentParameters.saltBytes);
      const digest = await derive(password, salt, currentParameters);
      return [
        HASH_PREFIX,
        String(currentParameters.version),
        String(currentParameters.iterations),
        bytesToBase64Url(salt),
        bytesToBase64Url(digest),
      ].join('$');
    },
    async verify(password: string, encodedHash: string | null): Promise<PasswordVerification> {
      if (encodedHash === null || encodedHash === '') {
        // Still perform a derivation so an unknown account and a wrong password
        // are not distinguishable by response time.
        await derive(password, randomBytes(currentParameters.saltBytes), currentParameters);
        return { valid: false, needsRehash: false };
      }
      const parsed = parseHash(encodedHash);
      if (parsed === null) {
        return { valid: false, needsRehash: false };
      }
      const candidate = await derive(password, parsed.salt, parsed.parameters);
      const valid = timingSafeEqualHex(bytesToHexLocal(candidate), bytesToHexLocal(parsed.digest));
      return {
        valid,
        needsRehash:
          valid &&
          (parsed.parameters.iterations < currentParameters.iterations ||
            parsed.parameters.version < currentParameters.version),
      };
    },
  };
}

function bytesToHexLocal(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

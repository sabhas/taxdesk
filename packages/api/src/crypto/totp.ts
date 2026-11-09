import { randomBytes } from './encoding.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpOptions {
  readonly digits: number;
  readonly stepSeconds: number;
  readonly window: number;
  readonly issuer: string;
}

export const TOTP_DEFAULTS: TotpOptions = {
  digits: 6,
  stepSeconds: 30,
  window: 1,
  issuer: 'TaxDesk',
};

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((value >>> bits) & 31);
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return output;
}

export function base32Decode(encoded: string): Uint8Array {
  const normalized = encoded.replaceAll(/\s|-/gu, '').replace(/=+$/u, '').toUpperCase();
  if (normalized.length === 0 || !/^[A-Z2-7]+$/u.test(normalized)) {
    throw new Error('Invalid base32 secret.');
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('Invalid base32 secret.');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, message);
  return new Uint8Array(signature);
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

/** RFC 4226 HOTP value for an arbitrary counter. */
export async function hotp(
  secret: string,
  counter: number,
  digits = TOTP_DEFAULTS.digits,
): Promise<string> {
  const digest = await hmacSha1(base32Decode(secret), counterBytes(counter));
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export async function totp(
  secret: string,
  at: number,
  options: Pick<TotpOptions, 'digits' | 'stepSeconds'> = TOTP_DEFAULTS,
): Promise<string> {
  const counter = Math.floor(at / 1000 / options.stepSeconds);
  return await hotp(secret, counter, options.digits);
}

export interface TotpService {
  readonly options: TotpOptions;
  generateSecret(): string;
  generate(secret: string, at: number): Promise<string>;
  verify(secret: string, code: string, at: number): Promise<boolean>;
  otpauthUri(secret: string, accountName: string): string;
}

export function createTotpService(options: TotpOptions = TOTP_DEFAULTS): TotpService {
  return {
    options,
    generateSecret: () => base32Encode(randomBytes(20)),
    generate: async (secret, at) => await totp(secret, at, options),
    async verify(secret, code, at): Promise<boolean> {
      if (!new RegExp(`^\\d{${String(options.digits)}}$`, 'u').test(code)) {
        return false;
      }
      const counter = Math.floor(at / 1000 / options.stepSeconds);
      for (let offset = -options.window; offset <= options.window; offset += 1) {
        const expected = await hotp(secret, counter + offset, options.digits);
        if (timingSafeEqual(expected, code)) {
          return true;
        }
      }
      return false;
    },
    otpauthUri(secret, accountName): string {
      const label = encodeURIComponent(`${options.issuer}:${accountName}`);
      const parameters = new URLSearchParams({
        secret,
        issuer: options.issuer,
        algorithm: 'SHA1',
        digits: String(options.digits),
        period: String(options.stepSeconds),
      });
      return `otpauth://totp/${label}?${parameters.toString()}`;
    },
  };
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

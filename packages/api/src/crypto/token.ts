import { bytesToBase64Url, bytesToHex, randomBytes } from './encoding.js';

export interface TokenHasher {
  /** Opaque, URL-safe session/activation/challenge token. */
  generate(byteLength?: number): string;
  /** SHA-256 hex digest. Only the digest is persisted. */
  hash(token: string): Promise<string>;
}

export function createTokenHasher(): TokenHasher {
  return {
    generate: (byteLength = 32) => bytesToBase64Url(randomBytes(byteLength)),
    hash: (token: string) => sha256Hex(token),
  };
}

/** Constant-time comparison for equal-length hex digests. */
export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

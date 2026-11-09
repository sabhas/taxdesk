/**
 * Binary encoders shared by password, token, TOTP, and cipher primitives.
 * Web Crypto and `btoa`/`atob` exist in Workers, Node 22, and browsers, so this
 * module has no Node-only dependency.
 */

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  return base64;
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('Invalid base64url value.');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = padded.length % 4;
  const base64 = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]*$/u.test(value) || value.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal value.');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('Random byte length must be a positive integer.');
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomToken(length = 32): string {
  return bytesToBase64Url(randomBytes(length));
}

export function base64UrlAlphabet(): string {
  return BASE64URL_ALPHABET;
}

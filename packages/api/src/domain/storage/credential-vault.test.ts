import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretCipher } from '../../crypto/cipher.js';
import { bytesToBase64Url } from '../../crypto/encoding.js';
import {
  CredentialVaultError,
  codeChallengeS256,
  decryptCredentials,
  encryptCredentials,
  generateCodeVerifier,
} from './credential-vault.js';

const KEY = bytesToBase64Url(new Uint8Array(32).fill(3));
const OTHER_KEY = bytesToBase64Url(new Uint8Array(32).fill(4));
const credentials = {
  accessToken: 'fake-access',
  refreshToken: 'fake-refresh',
  accessTokenExpiresAt: '2026-06-01T05:00:00.000Z',
  scopes: ['Files.ReadWrite.AppFolder'],
};

describe('credential vault', () => {
  it('round-trips credentials and records the key version', async () => {
    const cipher = createSecretCipher(KEY, 2, 'storage token encryption key');
    const encrypted = await encryptCredentials(cipher, credentials);
    expect(encrypted.keyVersion).toBe(2);
    expect(encrypted.ciphertext).not.toContain('synthetic');
    await expect(decryptCredentials(cipher, encrypted.ciphertext, 2)).resolves.toEqual(credentials);
  });

  it('rejects another key, another version, and tampered ciphertext', async () => {
    const cipher = createSecretCipher(KEY, 1, 'storage token encryption key');
    const encrypted = await encryptCredentials(cipher, credentials);
    const other = createSecretCipher(OTHER_KEY, 1, 'storage token encryption key');
    await expect(decryptCredentials(other, encrypted.ciphertext, 1)).rejects.toBeInstanceOf(
      CredentialVaultError,
    );
    await expect(decryptCredentials(cipher, encrypted.ciphertext, 2)).rejects.toBeInstanceOf(
      CredentialVaultError,
    );
    await expect(
      decryptCredentials(cipher, `${encrypted.ciphertext.slice(0, -2)}AA`, 1),
    ).rejects.toBeInstanceOf(CredentialVaultError);
    const notCredentials = await cipher.encrypt('{"accessToken":""}');
    await expect(decryptCredentials(cipher, notCredentials, 1)).rejects.toBeInstanceOf(
      CredentialVaultError,
    );
  });

  it('builds RFC 7636 verifiers and S256 challenges', async () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(generateCodeVerifier()).not.toBe(verifier);
    // S256 = base64url(SHA-256(verifier)), checked against Node's implementation.
    await expect(codeChallengeS256(verifier)).resolves.toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
  });
});

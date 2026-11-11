import { describe, expect, it } from 'vitest';
import { createSecretCipher } from './cipher.js';
import { bytesToBase64Url } from './encoding.js';
import { createIdentifierProtector } from './identifier-protection.js';

const ENCRYPTION_KEY = bytesToBase64Url(new Uint8Array(32).fill(1));
const INDEX_KEY = bytesToBase64Url(new Uint8Array(32).fill(2));

describe('client identifier protection', () => {
  const protector = createIdentifierProtector({
    encryptionKey: ENCRYPTION_KEY,
    indexKey: INDEX_KEY,
  });

  it('encrypts, indexes, and masks without keeping plaintext', async () => {
    const result = await protector.protect('cnic', '3520212345671');
    expect(result.masked).toBe('•••••-••••567-1');
    expect(result.blindIndex).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain('3520212345671');
    const decrypted = await createSecretCipher(ENCRYPTION_KEY).decrypt(result.ciphertext);
    expect(decrypted).toBe('3520212345671');
  });

  it('produces a deterministic index but fresh ciphertext', async () => {
    const first = await protector.protect('ntn', '12345678');
    const second = await protector.protect('ntn', '12345678');
    expect(first.blindIndex).toBe(second.blindIndex);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('separates identifier kinds and keys', async () => {
    const asCnic = await protector.blindIndex('cnic', '3520212345671');
    const asNtn = await protector.blindIndex('ntn', '3520212345671');
    expect(asCnic).not.toBe(asNtn);
    const otherKey = createIdentifierProtector({
      encryptionKey: ENCRYPTION_KEY,
      indexKey: bytesToBase64Url(new Uint8Array(32).fill(3)),
    });
    expect(await otherKey.blindIndex('cnic', '3520212345671')).not.toBe(asCnic);
  });

  it('rejects malformed or reused keys', () => {
    expect(() =>
      createIdentifierProtector({ encryptionKey: ENCRYPTION_KEY, indexKey: 'short' }),
    ).toThrow(/index key/u);
    expect(() =>
      createIdentifierProtector({ encryptionKey: ENCRYPTION_KEY, indexKey: ENCRYPTION_KEY }),
    ).toThrow(/differ/u);
    expect(() => createIdentifierProtector({ encryptionKey: 'AAAA', indexKey: INDEX_KEY })).toThrow(
      /client data encryption key/u,
    );
  });
});

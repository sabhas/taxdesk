import { describe, expect, it } from 'vitest';
import { makeTestFile, nodeRandomBytes, randomHex, sha256Hex } from './test-files.js';

describe('makeTestFile', () => {
  it('produces the exact requested size, including a non-block-aligned size', () => {
    expect(makeTestFile(0, 'seed')).toHaveLength(0);
    expect(makeTestFile(10, 'seed')).toHaveLength(10);
    expect(makeTestFile(70_001, 'seed')).toHaveLength(70_001);
  });

  it('is deterministic for the same seed and differs across seeds', () => {
    const first = makeTestFile(1024, 'run-a:simple');
    const second = makeTestFile(1024, 'run-a:simple');
    const other = makeTestFile(1024, 'run-a:chunked');

    expect(sha256Hex(first)).toBe(sha256Hex(second));
    expect(sha256Hex(first)).not.toBe(sha256Hex(other));
  });

  it('fills the whole file rather than leaving zero padding', () => {
    const bytes = makeTestFile(200_000, 'seed');
    const tail = bytes.subarray(bytes.length - 1024);
    expect(tail.some((byte) => byte !== 0)).toBe(true);
  });

  it('rejects an unusable size', () => {
    expect(() => makeTestFile(-1, 'seed')).toThrow(RangeError);
    expect(() => makeTestFile(1.5, 'seed')).toThrow(RangeError);
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty input', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('random helpers', () => {
  it('returns the requested number of random bytes and hex characters', () => {
    expect(nodeRandomBytes(32)).toHaveLength(32);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});

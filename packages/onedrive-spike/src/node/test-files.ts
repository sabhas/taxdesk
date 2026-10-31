import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Node-only helpers for the spike CLI. Everything here operates on synthetic
 * bytes; no client data, fixture binary, or personal information is involved.
 */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function nodeRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

export function randomHex(byteLength: number): string {
  return Buffer.from(randomBytes(byteLength)).toString('hex');
}

export const TEST_FILE_BLOCK_BYTES = 64 * 1024;

/**
 * Builds a deterministic, non-confidential test file by tiling a 64 KiB block
 * derived from a seed. The same seed always produces the same bytes, so a
 * recorded checksum can be re-derived without committing a binary fixture.
 *
 * This is synthetic filler for a feasibility probe, not cryptographic material.
 */
export function makeTestFile(sizeBytes: number, seed: string): Uint8Array {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError('sizeBytes must be a non-negative safe integer');
  }

  const block = new Uint8Array(TEST_FILE_BLOCK_BYTES);
  let filled = 0;
  let counter = 0;
  while (filled < block.length) {
    const digest = createHash('sha256')
      .update(`${seed}:${String(counter)}`)
      .digest();
    block.set(digest, filled);
    filled += digest.length;
    counter += 1;
  }

  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  while (offset < sizeBytes) {
    const slice = block.subarray(0, Math.min(block.length, sizeBytes - offset));
    bytes.set(slice, offset);
    offset += slice.length;
  }
  return bytes;
}

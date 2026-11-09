import { z } from 'zod';

/** Canonical UUID string form. TaxDesk persists UUIDv7 values. */
export const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export type Uuid = z.infer<typeof UuidSchema>;

/** UUIDv7 as accepted by the identity contracts (version nibble `7`). */
export const UuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export type UuidV7 = z.infer<typeof UuidV7Schema>;

export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hex(value: number, width: number): string {
  return (value & 0xffff).toString(16).padStart(width, '0');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Generates a UUIDv7 from a millisecond timestamp and random bytes. IDs are
 * time-ordered, which keeps index locality and gives audit/session listings a
 * stable cursor order without a separate sequence.
 *
 * Layout: 48-bit Unix milliseconds, 4-bit version (7), 12 random bits,
 * 2-bit variant (`10`), 62 random bits.
 */
export function newUuidV7(now: number = Date.now(), random: Uint8Array = randomBytes(10)): UuidV7 {
  if (random.length < 10) {
    throw new Error('Insufficient random bytes for a UUIDv7.');
  }

  const timestamp = Math.max(0, Math.trunc(now));
  const timeHex = timestamp.toString(16).padStart(12, '0').slice(-12);

  const part1 = timeHex.slice(0, 8);
  const part2 = timeHex.slice(8, 12);
  const twelveBits = ((random[0] ?? 0) << 8) | (random[1] ?? 0);
  const part3 = `7${hex(twelveBits & 0x0fff, 3)}`;
  const variant = ((random[2] ?? 0) & 0x3f) | 0x80;
  const part4 = `${hex(variant, 2)}${hex(random[3] ?? 0, 2)}`;
  const part5 = Array.from(random.slice(4, 10), (byte) => hex(byte, 2)).join('');

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

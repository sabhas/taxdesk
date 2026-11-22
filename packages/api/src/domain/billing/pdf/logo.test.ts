import { describe, expect, it } from 'vitest';
import {
  GIF_IMAGE,
  JPEG_LOGO,
  PNG_LOGO,
  oversizedPng,
  tooLargePng,
  truncatedJpeg,
  truncatedPng,
} from '../../../testing/logo-fixtures.js';
import { inspectLogoImage, LogoImageError, type LogoProblem } from './logo.js';

async function problemOf(bytes: Uint8Array): Promise<LogoProblem | null> {
  try {
    await inspectLogoImage(bytes);
    return null;
  } catch (error) {
    if (error instanceof LogoImageError) {
      return error.problem;
    }
    throw error;
  }
}

describe('firm logo inspection (TD-512)', () => {
  it('identifies PNG and JPEG from their bytes and reads the dimensions', async () => {
    await expect(inspectLogoImage(PNG_LOGO)).resolves.toEqual({
      contentType: 'image/png',
      width: 1,
      height: 1,
    });
    await expect(inspectLogoImage(JPEG_LOGO)).resolves.toEqual({
      contentType: 'image/jpeg',
      width: 2,
      height: 2,
    });
  });

  it('rejects other types, empty and oversized files, huge dimensions, and corrupt images', async () => {
    expect(await problemOf(GIF_IMAGE)).toBe('unsupported_type');
    expect(
      await problemOf(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe('unsupported_type');
    expect(await problemOf(new Uint8Array())).toBe('empty');
    expect(await problemOf(tooLargePng())).toBe('too_large');
    expect(await problemOf(oversizedPng())).toBe('too_many_pixels');
    expect(await problemOf(truncatedPng())).toBe('corrupt');
    expect(await problemOf(truncatedJpeg())).toBe('corrupt');
  });
});

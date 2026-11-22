import { decode as decodeJpeg } from 'jpeg-js';
import { PDFDocument } from 'pdf-lib';
import { FIRM_LOGO_LIMITS, type FirmLogoContentType } from '@taxdesk/shared';

/**
 * Firm logo checks (TD-512). The type comes from the file signature, never a
 * declared type or file name, and the image must embed in a PDF, because that
 * is the only place it is printed.
 */

const LOGO_MAX_SIDE_PIXELS = FIRM_LOGO_LIMITS.maxSidePixels;

export interface LogoImageInfo {
  readonly contentType: FirmLogoContentType;
  readonly width: number;
  readonly height: number;
}

export type LogoProblem =
  'empty' | 'too_large' | 'unsupported_type' | 'too_many_pixels' | 'corrupt';

export class LogoImageError extends Error {
  constructor(readonly problem: LogoProblem) {
    super(`Invalid logo image: ${problem}`);
    this.name = 'LogoImageError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** PNG width and height from the IHDR chunk, which must come first. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const isIhdr =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (bytes.length < 24 || !isIhdr) {
    return null;
  }
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

/** JPEG width and height from the first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start-of-frame markers, excluding DHT (C4), JPG (C8), and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: readUint16(bytes, offset + 5), width: readUint16(bytes, offset + 7) };
    }
    const length = readUint16(bytes, offset + 2);
    if (length < 2) {
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

/** Identifies and validates a logo, or throws a `LogoImageError`. */
export async function inspectLogoImage(bytes: Uint8Array): Promise<LogoImageInfo> {
  if (bytes.length === 0) {
    throw new LogoImageError('empty');
  }
  if (bytes.length > FIRM_LOGO_LIMITS.maxBytes) {
    throw new LogoImageError('too_large');
  }
  const contentType: FirmLogoContentType | null = isPng(bytes)
    ? 'image/png'
    : isJpeg(bytes)
      ? 'image/jpeg'
      : null;
  if (contentType === null) {
    throw new LogoImageError('unsupported_type');
  }
  const size = contentType === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (size === null || size.width === 0 || size.height === 0) {
    throw new LogoImageError('corrupt');
  }
  if (size.width > LOGO_MAX_SIDE_PIXELS || size.height > LOGO_MAX_SIDE_PIXELS) {
    throw new LogoImageError('too_many_pixels');
  }
  try {
    const document = await PDFDocument.create();
    if (contentType === 'image/png') {
      // pdf-lib decodes every PNG pixel while embedding.
      await document.embedPng(bytes);
    } else {
      // pdf-lib passes JPEG data through after reading its header, so decode
      // it here, strictly, to catch damaged image data.
      decodeJpeg(bytes, {
        useTArray: true,
        tolerantDecoding: false,
        formatAsRGBA: false,
        maxResolutionInMP: (LOGO_MAX_SIDE_PIXELS * LOGO_MAX_SIDE_PIXELS) / 1_000_000,
        maxMemoryUsageInMB: 64,
      });
      await document.embedJpg(bytes);
    }
  } catch {
    throw new LogoImageError('corrupt');
  }
  return { contentType, ...size };
}

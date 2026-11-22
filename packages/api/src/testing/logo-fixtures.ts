import { encode as encodeJpeg } from 'jpeg-js';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/**
 * Synthetic logo images for TD-512 tests. Built in code so no binary fixture
 * files are committed.
 */

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** A valid 1×1 PNG. */
export const PNG_LOGO = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);

/** A valid 2×2 baseline JPEG, encoded by the same library the API decodes with. */
export const JPEG_LOGO: Uint8Array = new Uint8Array(
  encodeJpeg({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }, 90).data,
);

/** A JPEG cut off in the middle of its image data: the header still parses. */
export function truncatedJpeg(): Uint8Array {
  const start = JPEG_LOGO.findIndex(
    (byte, index) => byte === 0xff && JPEG_LOGO[index + 1] === 0xda,
  );
  return JPEG_LOGO.slice(0, start + 16);
}

/** A GIF header: a real image, but not a type the PDF renderer can embed. */
export const GIF_IMAGE = new TextEncoder().encode(
  'GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;',
);

/** The PNG with its IHDR width and height rewritten to 5000×5000 pixels. */
export function oversizedPng(): Uint8Array {
  const bytes = new Uint8Array(PNG_LOGO);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 5000);
  view.setUint32(20, 5000);
  return bytes;
}

/** A PNG signature and header with the image data cut off. */
export function truncatedPng(): Uint8Array {
  return PNG_LOGO.slice(0, 33);
}

/** Bytes over the 512 KiB limit that start like a PNG. */
export function tooLargePng(): Uint8Array {
  const bytes = new Uint8Array(512 * 1024 + 1);
  bytes.set(PNG_LOGO);
  return bytes;
}

/** Image XObjects in a PDF: the firm logo is the only image a billing PDF has. */
export async function imageCount(bytes: Uint8Array): Promise<number> {
  const loaded = await PDFDocument.load(bytes);
  return loaded.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    ).length;
}

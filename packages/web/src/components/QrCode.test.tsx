import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import jsQR from 'jsqr';
import { QrCode, qrPath } from './QrCode.js';

afterEach(cleanup);

// Obviously fake all-'A' secret: realistic test seeds trip the secret history scan.
const URI = `otpauth://totp/TaxDesk:owner%40example.test?secret=${'A'.repeat(32)}&issuer=TaxDesk&algorithm=SHA1&digits=6&period=30`;

/** Rasterises the `M{x} {y}h1v1h-1z` path into RGBA pixels at `scale` px per module. */
function rasterise(path: string, dimension: number, scale: number) {
  const width = dimension * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const column = Number(match[1]);
    const row = Number(match[2]);
    for (let y = row * scale; y < (row + 1) * scale; y += 1) {
      for (let x = column * scale; x < (column + 1) * scale; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
    }
  }
  return { pixels, width };
}

describe('QrCode', () => {
  it('draws a code that decodes back to the exact otpauth URI', () => {
    const { path, dimension } = qrPath(URI);
    const { pixels, width } = rasterise(path, dimension, 4);
    expect(jsQR(pixels, width, width)?.data).toBe(URI);
  });

  it('renders an accessible image without network URLs or injected markup', () => {
    const { container } = render(<QrCode value={URI} label="Scan to add TaxDesk" />);
    const image = screen.getByRole('img', { name: 'Scan to add TaxDesk' });
    expect(image.tagName.toLowerCase()).toBe('svg');
    expect(container.innerHTML).not.toMatch(/https?:|href=|<image/u);
  });
});

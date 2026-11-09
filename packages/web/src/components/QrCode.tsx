import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Quiet zone in modules; scanners need a light border around the code. */
const QUIET_ZONE = 4;

export interface QrCodeProps {
  /** Text to encode. For MFA this is the `otpauth://` URI, which contains the secret. */
  readonly value: string;
  /** Accessible description of what scanning the code does. */
  readonly label: string;
  /** Rendered width and height in CSS pixels. */
  readonly size?: number;
}

/**
 * Builds one SVG path covering every dark module so the code renders as a
 * single crisp shape at any size.
 */
export function qrPath(value: string): { readonly path: string; readonly dimension: number } {
  const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const segments: string[] = [];
  for (let row = 0; row < modules.size; row += 1) {
    for (let column = 0; column < modules.size; column += 1) {
      if (modules.get(row, column)) {
        segments.push(`M${String(column + QUIET_ZONE)} ${String(row + QUIET_ZONE)}h1v1h-1z`);
      }
    }
  }
  return { path: segments.join(''), dimension: modules.size + QUIET_ZONE * 2 };
}

/**
 * QR code drawn locally as inline SVG. The encoded value never leaves the
 * browser: no image service, no network request, no `innerHTML`, so the code
 * stays inside the strict content security policy. Colors are fixed black on
 * white in every theme because scanners need that contrast.
 */
export function QrCode({ value, label, size = 192 }: QrCodeProps) {
  const { path, dimension } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${String(dimension)} ${String(dimension)}`}
      shapeRendering="crispEdges"
    >
      <rect width={dimension} height={dimension} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

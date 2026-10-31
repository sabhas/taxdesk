import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './request-id.js';

describe('resolveRequestId', () => {
  it('keeps a well-formed caller-supplied request ID', () => {
    expect(resolveRequestId('req-supplied')).toBe('req-supplied');
    expect(resolveRequestId('  req-trimmed  ')).toBe('req-trimmed');
  });

  it('generates a request ID when the header is missing or unsafe', () => {
    const generate = () => 'generated-id';
    expect(resolveRequestId(undefined, generate)).toBe('generated-id');
    expect(resolveRequestId('', generate)).toBe('generated-id');
    expect(resolveRequestId('bad value', generate)).toBe('generated-id');
    expect(resolveRequestId('req\r\nInjected: true', generate)).toBe('generated-id');
  });
});

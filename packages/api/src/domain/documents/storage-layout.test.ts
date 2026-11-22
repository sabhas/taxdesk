import { describe, expect, it } from 'vitest';
import { buildDocumentStoragePath, StorageLayoutError } from './storage-layout.js';

describe('browsable storage layout (TD-411)', () => {
  it('files case documents under client code, tax year, and case code', () => {
    expect(
      buildDocumentStoragePath({
        clientCode: 'CL-00042',
        taxYear: 2026,
        caseCode: 'TC-00007',
        fileName: 'Bank statement.pdf',
      }),
    ).toEqual({
      segments: ['clients', 'CL-00042', '2026', 'TC-00007'],
      fileName: 'Bank statement.pdf',
    });
  });

  it('files client-level documents directly under the general folder', () => {
    expect(
      buildDocumentStoragePath({
        clientCode: 'CL-00042',
        taxYear: null,
        caseCode: null,
        fileName: 'cnic.png',
      }),
    ).toEqual({ segments: ['clients', 'CL-00042', 'general'], fileName: 'cnic.png' });
  });

  it('uses no IDs or names, so the same codes always give the same folder', () => {
    // The input has no name or ID fields at all: only codes and the tax year.
    const location = {
      clientCode: 'CL-00007',
      taxYear: 2025,
      caseCode: 'TC-00042',
      fileName: 'return.pdf',
    };
    const path = buildDocumentStoragePath(location);
    expect(buildDocumentStoragePath({ ...location })).toEqual(path);
    expect(path.segments.join('/')).toBe('clients/CL-00007/2025/TC-00042');
    expect(path.segments.join('/')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/iu);
  });

  it('rejects unstable or unsafe inputs', () => {
    const base = { clientCode: 'CL-00001', taxYear: 2026, caseCode: 'TC-00001', fileName: 'a.pdf' };
    const rejects = (input: Partial<Record<keyof typeof base, unknown>>): void => {
      expect(() => buildDocumentStoragePath({ ...base, ...input } as typeof base)).toThrow(
        StorageLayoutError,
      );
    };
    rejects({ clientCode: 'Acme Ltd' });
    rejects({ clientCode: '../CL-00001' });
    rejects({ caseCode: '0190e3a0-0000-7000-8000-000000000000' });
    rejects({ caseCode: 'TC-1/..' });
    rejects({ fileName: '../a.pdf' });
    rejects({ fileName: 'run.exe' });
    rejects({ taxYear: 2026.5 });
    rejects({ taxYear: 0 });
    // A case code needs its tax year, and a tax year needs a case code.
    rejects({ taxYear: null });
    rejects({ caseCode: null });
  });
});

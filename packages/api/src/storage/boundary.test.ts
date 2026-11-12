import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TD-401 / Epic 4 exit criterion: business code stays provider-neutral. Domain
 * services, routes, and repositories reach storage only through
 * `DocumentStorageProvider`; nothing outside `storage/onedrive/` and the
 * provider factory imports the OneDrive adapter, Microsoft libraries, or the
 * throwaway TD-005 spike.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

const PROVIDER_SPECIFIC = [
  /(^|\/)onedrive(\/|$|-)/iu,
  /^@microsoft\//u,
  /(^|\/)graph(\/|$|-|\.)/iu,
  /^@taxdesk\/onedrive-spike/u,
];

describe('storage provider boundary', () => {
  it('extracts import specifiers', () => {
    expect(
      importSpecifiers(
        "import { a } from './x.js';\nimport type { B } from '../storage/onedrive/http.js';\nexport { c } from '@microsoft/graph';\nconst d = await import('graph-sdk');",
      ),
    ).toEqual(['./x.js', '../storage/onedrive/http.js', '@microsoft/graph', 'graph-sdk']);
  });

  it.each(['domain', 'routes', 'repositories'])(
    'keeps src/%s free of provider-specific imports',
    async (folder) => {
      const offenders: string[] = [];
      for (const file of await sourceFiles(join(SRC, folder))) {
        for (const specifier of importSpecifiers(await readFile(file, 'utf8'))) {
          if (PROVIDER_SPECIFIC.some((pattern) => pattern.test(specifier))) {
            offenders.push(`${relative(SRC, file)} → ${specifier}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it('lets only the provider factory import the OneDrive adapter', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const path = relative(SRC, file).replaceAll('\\', '/');
      if (path.startsWith('storage/onedrive/') || path === 'storage/provider-factory.ts') {
        continue;
      }
      if (path === 'storage/boundary.test.ts') {
        continue;
      }
      for (const specifier of importSpecifiers(await readFile(file, 'utf8'))) {
        if (PROVIDER_SPECIFIC.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${path} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

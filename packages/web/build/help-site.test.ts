import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpSiteError, TRAINING_GUIDE_DIR, buildHelpSite, stripExcluded } from './help-site.js';

const UNPUBLISHED =
  /operators\/|testing\/|status-limitations|security-data-handling|uat\.js|uat-data\.js/u;

function searchIndex(files: ReadonlyMap<string, string>): { url: string; sections: string[][] }[] {
  const source = files.get('assets/search-index.js') ?? '';
  const json = source.slice(source.indexOf('= ') + 2, source.lastIndexOf(';'));
  return JSON.parse(json) as { url: string; sections: string[][] }[];
}

describe('help site from docs/training', () => {
  it('publishes only the staff home, staff guides, and staff reference pages', async () => {
    const files = await buildHelpSite();
    const paths = [...files.keys()];

    expect(paths).toContain('index.html');
    expect(paths).toContain('staff/getting-started.html');
    expect(paths).toContain('reference/troubleshooting.html');
    expect(paths).toContain('reference/glossary.html');
    for (const path of paths) {
      expect(path).toMatch(
        /^(?:index\.html|staff\/[\w-]+\.html|reference\/(?:glossary|troubleshooting)\.html|assets\/(?:guide\.css|guide\.js|search-index\.js))$/u,
      );
    }
  });

  it('never links to, lists, or names an unpublished page', async () => {
    const files = await buildHelpSite();
    for (const [path, content] of files) {
      if (path.endsWith('.html') || path.endsWith('.js')) {
        expect(content, path).not.toMatch(UNPUBLISHED);
      }
    }
    expect(
      searchIndex(files)
        .map((page) => page.url)
        .sort(),
    ).toEqual([...files.keys()].filter((path) => path.endsWith('.html')).sort());
  });

  it('removes excluded operator sections from published pages and search', async () => {
    const files = await buildHelpSite();
    const troubleshooting = files.get('reference/troubleshooting.html') ?? '';

    expect(troubleshooting).toContain('id="staff"');
    expect(troubleshooting).not.toContain('id="operator"');
    expect(troubleshooting).not.toContain('wrangler');
    expect(files.get('staff/data-import.html')).not.toContain('id="practice"');
    for (const content of files.values()) {
      expect(content).not.toContain('help:exclude');
    }
    const sections = searchIndex(files).flatMap((page) => page.sections.map((s) => s[0]));
    expect(sections).not.toContain('operator');
  });

  it('marks every page as the help edition and makes the staff home the index', async () => {
    const files = await buildHelpSite();
    for (const [path, content] of files) {
      if (path.endsWith('.html')) {
        expect(content, path).toContain('<body data-edition="help" ');
        expect(content, path).not.toContain('TaxDesk Training</title>');
      }
    }
    expect(files.get('index.html')).toContain('data-page="index.html"');
    expect(files.get('assets/guide.js')).toContain('"title": "Help home"');
  });
});

describe('exclusion markers', () => {
  it('removes each balanced block', () => {
    const problems: string[] = [];
    const html =
      'a<!-- help:exclude -->b<!-- /help:exclude -->c<!-- help:exclude -->d<!-- /help:exclude -->';
    expect(stripExcluded(html, 'p.html', problems)).toBe('ac');
    expect(problems).toEqual([]);
  });

  it.each([
    ['an unclosed start', 'a<!-- help:exclude -->b'],
    ['a stray end', 'a<!-- /help:exclude -->b'],
    [
      'a nested block',
      '<!-- help:exclude --><!-- help:exclude -->x<!-- /help:exclude --><!-- /help:exclude -->',
    ],
  ])('reports %s', (_name, html) => {
    const problems: string[] = [];
    stripExcluded(html, 'p.html', problems);
    expect(problems).toHaveLength(1);
  });
});

describe('build guards', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function guideCopy(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'taxdesk-help-'));
    await cp(TRAINING_GUIDE_DIR, dir, { recursive: true });
    return dir;
  }

  it('fails when a published page links to an unpublished page', async () => {
    const source = await guideCopy();
    const page = join(source, 'staff', 'clients.html');
    const html = await readFile(page, 'utf8');
    await writeFile(
      page,
      html.replace('</h1>', '</h1><a href="../operators/production.html">x</a>'),
    );

    await expect(buildHelpSite(source)).rejects.toThrow(HelpSiteError);
    await expect(buildHelpSite(source)).rejects.toThrow(
      /staff\/clients\.html: links to "\.\.\/operators\/production\.html"/u,
    );
  });

  it('fails when a page leaves an exclusion block open', async () => {
    const source = await guideCopy();
    const page = join(source, 'staff', 'roles.html');
    const html = await readFile(page, 'utf8');
    await writeFile(page, html.replace('</h1>', '</h1><!-- help:exclude -->'));

    await expect(buildHelpSite(source)).rejects.toThrow(/staff\/roles\.html: .* is never closed/u);
  });

  it('fails when a page links outside help to an app path', async () => {
    const source = await guideCopy();
    const page = join(source, 'staff', 'cases.html');
    const html = await readFile(page, 'utf8');
    await writeFile(page, html.replace('</h1>', '</h1><a href="/api/v1/cases">x</a>'));

    await expect(buildHelpSite(source)).rejects.toThrow(
      /links outside help to "\/api\/v1\/cases"/u,
    );
  });
});

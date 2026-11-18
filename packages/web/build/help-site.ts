/**
 * TD-806: builds the staff help bundle served at `/help/` from the build-free
 * training guide in `docs/training/`.
 *
 * Only staff-facing pages are published. Operator runbooks, the UAT catalogue,
 * and internal release notes stay in the repository. Inside a published page,
 * text wrapped in `<!-- help:exclude -->` … `<!-- /help:exclude -->` is removed.
 * The build fails when a published page links to a page that is not published,
 * so a new cross-link can never leak an operator page or ship a dead link.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `docs/training/` in this repository. */
export const TRAINING_GUIDE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/training',
);

/** The URL prefix the bundle is served under, and its folder in `dist/`. */
export const HELP_BASE_PATH = '/help/';

/** Every page under these guide folders is published. */
const PUBLISHED_FOLDERS = ['staff'] as const;

/** Single pages published from other folders. */
const PUBLISHED_PAGES = ['reference/glossary.html', 'reference/troubleshooting.html'] as const;

/** The staff home page, published as the bundle's `index.html`. */
const HOME_SOURCE = 'help-home.html';
const HOME_OUTPUT = 'index.html';

/** Static assets copied unchanged. The search index is generated, never copied. */
const PUBLISHED_ASSETS = ['assets/guide.css', 'assets/guide.js'] as const;
const SEARCH_INDEX = 'assets/search-index.js';

const GUIDE_SCRIPT = 'assets/guide.js';
const SITE_MAP_START = '/* site-map:start */';
const SITE_MAP_END = '/* site-map:end */';

const EXCLUDE_START = '<!-- help:exclude -->';
const EXCLUDE_END = '<!-- /help:exclude -->';

const TRACKS: Readonly<Record<string, string>> = {
  '.': 'Start',
  staff: 'Staff',
  reference: 'Reference',
};

export class HelpSiteError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The help site cannot be built:\n- ${problems.join('\n- ')}`);
    this.name = 'HelpSiteError';
  }
}

/** Removes every exclusion block. Unbalanced or nested markers are an error. */
export function stripExcluded(html: string, page: string, problems: string[]): string {
  let output = '';
  let cursor = 0;
  for (;;) {
    const start = html.indexOf(EXCLUDE_START, cursor);
    const strayEnd = html.indexOf(EXCLUDE_END, cursor);
    if (start === -1) {
      if (strayEnd !== -1) {
        problems.push(`${page}: "${EXCLUDE_END}" without a matching start marker`);
      }
      return output + html.slice(cursor);
    }
    if (strayEnd !== -1 && strayEnd < start) {
      problems.push(`${page}: "${EXCLUDE_END}" without a matching start marker`);
      return html;
    }
    const end = html.indexOf(EXCLUDE_END, start + EXCLUDE_START.length);
    const nested = html.indexOf(EXCLUDE_START, start + EXCLUDE_START.length);
    if (end === -1) {
      problems.push(`${page}: "${EXCLUDE_START}" is never closed`);
      return html;
    }
    if (nested !== -1 && nested < end) {
      problems.push(`${page}: exclusion markers cannot be nested`);
      return html;
    }
    output += html.slice(cursor, start);
    cursor = end + EXCLUDE_END.length;
  }
}

interface SiteGroup {
  readonly track: string;
  readonly pages: readonly { readonly url: string; readonly title: string }[];
}

function isSiteMap(value: unknown): value is SiteGroup[] {
  return (
    Array.isArray(value) &&
    value.every(
      (group: unknown) =>
        typeof group === 'object' &&
        group !== null &&
        typeof (group as SiteGroup).track === 'string' &&
        Array.isArray((group as SiteGroup).pages),
    )
  );
}

/**
 * Rewrites the sidebar site map in `guide.js` to list only published pages, so
 * the shipped script does not name operator or tester pages either. The array
 * literal is the repository's own source, evaluated at build time only.
 */
function publishedSiteMap(
  script: string,
  files: ReadonlyMap<string, string>,
  problems: string[],
): string {
  const start = script.indexOf(SITE_MAP_START);
  const end = script.indexOf(SITE_MAP_END);
  if (start === -1 || end === -1 || end < start) {
    problems.push(`${GUIDE_SCRIPT}: site-map markers are missing`);
    return script;
  }
  const literal = script.slice(start + SITE_MAP_START.length, end);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- trusted repository source, build time only
  const evaluate = new Function(`return (${literal});`) as () => unknown;
  const site = evaluate();
  if (!isSiteMap(site)) {
    problems.push(`${GUIDE_SCRIPT}: the site map is not a list of { track, pages } groups`);
    return script;
  }
  const published = site
    .map((group) => ({
      track: group.track,
      pages: group.pages
        // The full guide's home is not published; the staff home takes its place.
        .map((page) => (page.url === HOME_OUTPUT ? { ...page, title: 'Help home' } : page))
        .filter((page) => files.has(page.url)),
    }))
    .filter((group) => group.pages.length > 0);
  return (
    script.slice(0, start) +
    SITE_MAP_START +
    ' ' +
    JSON.stringify(published, null, 2) +
    ' ' +
    script.slice(end)
  );
}

/** Marks a page as the help edition and adjusts the training-only wording. */
function toHelpEdition(html: string, page: string, problems: string[]): string {
  if (!/<body\s/u.test(html)) {
    problems.push(`${page}: has no <body> element`);
    return html;
  }
  let output = html
    .replace(/<body\s/u, '<body data-edition="help" ')
    .replace(/ · TaxDesk Training<\/title>/u, ' · TaxDesk Help</title>')
    .replace(/(<p class="breadcrumb">)Track B · Staff/u, '$1Staff guide');
  if (page === HOME_OUTPUT) {
    output = output.replace(`data-page="${HOME_SOURCE}"`, `data-page="${HOME_OUTPUT}"`);
  }
  return output;
}

function isExternal(reference: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference);
}

/** Every relative `href`/`src` in a published page must point at a published file. */
function checkLinks(files: ReadonlyMap<string, string>, problems: string[]): void {
  for (const [page, content] of files) {
    if (!page.endsWith('.html')) {
      continue;
    }
    for (const match of content.matchAll(/\s(?:href|src)="([^"]*)"/gu)) {
      const reference = match[1] ?? '';
      if (reference === '' || reference.startsWith('#') || isExternal(reference)) {
        continue;
      }
      if (reference.startsWith('/')) {
        // Root-relative links leave the bundle; only the app's home is expected.
        if (reference !== '/') {
          problems.push(`${page}: links outside help to "${reference}"`);
        }
        continue;
      }
      const target = posix.normalize(
        posix.join(posix.dirname(page), reference.split(/[?#]/u)[0] ?? ''),
      );
      if (!files.has(target)) {
        problems.push(`${page}: links to "${reference}", which is not published in help`);
      }
    }
  }
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

interface SearchEntry {
  readonly title: string;
  readonly url: string;
  readonly track: string;
  readonly keywords: string;
  readonly sections: readonly (readonly [string, string])[];
}

/**
 * The same page record as `docs/training/tools/build-search-index.mjs`, built
 * from the published (already stripped) pages so search never lists excluded
 * sections or unpublished pages.
 */
function searchEntry(url: string, html: string): SearchEntry {
  const folder = url.includes('/') ? (url.split('/')[0] ?? '.') : '.';
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/u.exec(html);
  const sections: (readonly [string, string])[] = [];
  for (const match of html.matchAll(/<h([23])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/gu)) {
    sections.push([match[2] ?? '', text(match[3] ?? '')]);
  }
  const lede = /<p class="lede[^"]*">([\s\S]*?)<\/p>/u.exec(html);
  const codes = [...html.matchAll(/<code>([^<]{3,60})<\/code>/gu)].map((m) => text(m[1] ?? ''));
  const keywords = [lede ? text(lede[1] ?? '') : '', ...new Set(codes)].join(' ').slice(0, 1200);
  return {
    title: h1 ? text(h1[1] ?? '') : url,
    url,
    track: TRACKS[folder] ?? 'Guide',
    keywords,
    sections,
  };
}

async function htmlFilesIn(sourceDir: string, folder: string): Promise<string[]> {
  const entries = await readdir(join(sourceDir, folder), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => `${folder}/${entry.name}`);
}

/**
 * Builds the bundle in memory: published path (relative to `/help/`) → content.
 * Throws {@link HelpSiteError} listing every problem found.
 */
export async function buildHelpSite(
  sourceDir: string = TRAINING_GUIDE_DIR,
): Promise<Map<string, string>> {
  const problems: string[] = [];
  const pages: [source: string, output: string][] = [[HOME_SOURCE, HOME_OUTPUT]];
  for (const folder of PUBLISHED_FOLDERS) {
    for (const page of await htmlFilesIn(sourceDir, folder)) {
      pages.push([page, page]);
    }
  }
  for (const page of PUBLISHED_PAGES) {
    pages.push([page, page]);
  }
  pages.sort((a, b) => a[1].localeCompare(b[1]));

  const files = new Map<string, string>();
  for (const [source, output] of pages) {
    const html = await readFile(join(sourceDir, source), 'utf8');
    files.set(output, toHelpEdition(stripExcluded(html, source, problems), output, problems));
  }
  for (const asset of PUBLISHED_ASSETS) {
    const content = await readFile(join(sourceDir, asset), 'utf8');
    files.set(asset, asset === GUIDE_SCRIPT ? publishedSiteMap(content, files, problems) : content);
  }

  const index = [...files]
    .filter(([path]) => path.endsWith('.html'))
    .map(([path, html]) => searchEntry(path, html));
  files.set(
    SEARCH_INDEX,
    '/* Generated by packages/web/build/help-site.ts for /help/. Do not edit. */\n' +
      `window.TAXDESK_GUIDE_INDEX = ${JSON.stringify(index)};\n`,
  );

  checkLinks(files, problems);
  if (problems.length > 0) {
    throw new HelpSiteError(problems);
  }
  return files;
}

/** Writes the bundle to `<outDir>/help/`, replacing any previous copy. */
export async function writeHelpSite(
  outDir: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const helpDir = join(outDir, HELP_BASE_PATH);
  await rm(helpDir, { recursive: true, force: true });
  for (const [path, content] of files) {
    const target = join(helpDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

export function helpContentType(path: string): string {
  return CONTENT_TYPES[posix.extname(path)] ?? 'application/octet-stream';
}

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_HOME, HELP_TOPICS, helpPathFor, helpReturnPath } from './help.js';
import { NAV_ROUTES, ROUTE_PATHS } from './routes.js';

const GUIDE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'training',
);

describe('help links', () => {
  it('opens the matching guide page for a screen and its nested pages', () => {
    expect(helpPathFor('/clients')).toBe('/help/staff/clients.html');
    expect(helpPathFor('/clients/0192/edit')).toBe('/help/staff/clients.html');
    expect(helpPathFor('/invoices/abc')).toBe('/help/staff/billing.html');
    expect(helpPathFor('/')).toBe('/help/staff/dashboard-reports.html#dashboard');
    expect(helpPathFor(ROUTE_PATHS.storage)).toBe('/help/staff/administration.html#storage');
  });

  it('falls back to the help home for an unknown screen', () => {
    expect(helpPathFor('/unknown')).toBe(HELP_HOME);
    expect(helpPathFor('/clientsx')).toBe(HELP_HOME);
  });

  it('has a topic for every navigation screen', () => {
    for (const route of NAV_ROUTES) {
      expect(helpPathFor(route.path), route.path).not.toBe(HELP_HOME);
    }
  });

  it.each(HELP_TOPICS.map(([, page]) => page))(
    'points at a published guide page and anchor: %s',
    (topic) => {
      const [page = '', anchor] = topic.split('#');
      expect(page).toMatch(/^staff\//u);
      const file = join(GUIDE_DIR, page);
      expect(existsSync(file)).toBe(true);
      if (anchor !== undefined) {
        expect(readFileSync(file, 'utf8')).toContain(`id="${anchor}"`);
      }
    },
  );
});

describe('return to help after sign-in', () => {
  it.each([
    ['?returnTo=%2Fhelp%2Fstaff%2Fcases.html', '/help/staff/cases.html'],
    ['?returnTo=%2Fhelp%2F', '/help/'],
    ['?returnTo=%2Fhelp', '/help'],
    ['?returnTo=%2Fhelp%2Fstaff%2Fcases.html%3Fx%3D1', '/help/staff/cases.html?x=1'],
  ])('accepts %s', (search, expected) => {
    expect(helpReturnPath(search)).toBe(expected);
  });

  it.each([
    '',
    '?returnTo=',
    '?returnTo=https%3A%2F%2Fevil.example%2Fhelp',
    '?returnTo=%2F%2Fevil.example%2Fhelp',
    '?returnTo=%2Fhelp%2F%2Fevil.example',
    '?returnTo=%2Fhelp%2F..%2Fapi%2Fv1%2Fusers',
    '?returnTo=%2Fhelpful',
    '?returnTo=%2Fclients',
    '?returnTo=%2Fhelp%5C..%5Cevil',
    '?returnTo=javascript%3Aalert(1)',
  ])('rejects %s', (search) => {
    expect(helpReturnPath(search)).toBeNull();
  });
});

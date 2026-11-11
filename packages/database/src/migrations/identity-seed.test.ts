import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, ROLE_DEFINITIONS, ROLE_KEYS } from '@taxdesk/shared';

const IDENTITY_MIGRATIONS = [
  '0002_identity_and_authorization.sql',
  '0003_consultant_assigned_case_work.sql',
  '0005_client_management.sql',
  '0006_tax_case_workflow.sql',
] as const;

const sources = await Promise.all(
  IDENTITY_MIGRATIONS.map(async (name) =>
    readFile(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), 'utf8'),
  ),
);

// The role/permission catalog is the union of every identity migration, in order.
const sql = sources.join('\n');
const [identitySql = ''] = sources;

function block(start: string, end: string): string {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from);
  if (from === -1 || to === -1) {
    throw new Error(`Could not find migration block ${start}`);
  }
  return sql.slice(from + start.length, to);
}

function quotedValues(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('identity migration seed', () => {
  it('seeds exactly the shared built-in role catalog', () => {
    const seededRoles = quotedValues(block('INSERT INTO roles (', 'ON CONFLICT (key) DO NOTHING;'))
      .filter((value) => (ROLE_KEYS as readonly string[]).includes(value))
      .sort();
    expect(seededRoles).toEqual([...ROLE_KEYS].sort());
  });

  it('seeds exactly the shared permission catalog', () => {
    const seeded = [
      ...sql.matchAll(/INSERT INTO permissions \([\s\S]*?ON CONFLICT \(key\) DO NOTHING;/g),
    ]
      .flatMap((match) => quotedValues(match[0]))
      .filter((value) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value));
    expect([...new Set(seeded)].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it('seeds exactly the shared role/permission matrix', () => {
    const pattern =
      /JOIN permissions p ON p\.key = ANY \(ARRAY\[([\s\S]*?)\]::text\[\]\)\s*WHERE r\.key = '([a-z_]+)'/g;
    const seeded = new Map<string, string[]>();
    for (const match of sql.matchAll(pattern)) {
      const permissions = quotedValues(match[1] ?? '');
      const role = match[2] ?? '';
      seeded.set(role, [...(seeded.get(role) ?? []), ...permissions].sort());
    }

    expect([...seeded.keys()].sort()).toEqual([...ROLE_KEYS].sort());
    for (const role of ROLE_KEYS) {
      expect(seeded.get(role)).toEqual([...ROLE_DEFINITIONS[role].permissions].sort());
    }
  });

  it('keeps audit events append-only at the database layer', () => {
    expect(identitySql).toContain('CREATE TRIGGER audit_events_append_only');
    expect(identitySql).toContain('BEFORE UPDATE OR DELETE ON audit_events');
  });

  it('never introduces a tenant/organization scope', () => {
    expect(sql.toLowerCase()).not.toContain('organization_id');
  });
});

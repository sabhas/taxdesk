import { describe, expect, it } from 'vitest';
import {
  ClientCreateRequestSchema,
  ClientListQuerySchema,
  ClientUpdateRequestSchema,
  formatClientCode,
  formatCnic,
  formatNtn,
  maskIdentifier,
  normalizeClientName,
  normalizeCnic,
  normalizeEmail,
  normalizeNtn,
  normalizePhone,
} from './client.js';
import { ROLE_DEFINITIONS, roleHasPermission } from './identity.js';

const MANAGER_ID = '0198a000-0000-7000-8000-0000000000aa';

function issues(result: { success: boolean; error?: { issues: { path: unknown[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('.'));
}

describe('client codes', () => {
  it('formats stable, zero-padded codes', () => {
    expect(formatClientCode(1)).toBe('CL-00001');
    expect(formatClientCode(123456)).toBe('CL-123456');
  });

  it('rejects non-positive sequences', () => {
    expect(() => formatClientCode(0)).toThrow();
    expect(() => formatClientCode(1.5)).toThrow();
  });
});

describe('national identifiers', () => {
  it('normalizes CNIC with or without separators', () => {
    expect(normalizeCnic('35202-1234567-1')).toBe('3520212345671');
    expect(normalizeCnic(' 3520212345671 ')).toBe('3520212345671');
    expect(normalizeCnic('35202-123456-1')).toBeNull();
    expect(normalizeCnic('abc')).toBeNull();
  });

  it('normalizes 7-digit, check-digit, and CNIC-based NTNs', () => {
    expect(normalizeNtn('1234567')).toBe('1234567');
    expect(normalizeNtn('1234567-8')).toBe('12345678');
    expect(normalizeNtn('35202-1234567-1')).toBe('3520212345671');
    expect(normalizeNtn('12345')).toBeNull();
  });

  it('formats and masks identifiers, keeping only four digits', () => {
    expect(formatCnic('3520212345671')).toBe('35202-1234567-1');
    expect(formatNtn('12345678')).toBe('1234567-8');
    expect(maskIdentifier('35202-1234567-1')).toBe('•••••-••••567-1');
    expect(maskIdentifier('1234567-8')).toBe('••••567-8');
    const masked = maskIdentifier('35202-1234567-1');
    expect(masked.replace(/\D/gu, '')).toHaveLength(4);
  });
});

describe('search normalization', () => {
  it('normalizes names for search and duplicate detection', () => {
    expect(normalizeClientName('ABC Traders (Pvt.) Ltd.')).toBe('abc traders');
    expect(normalizeClientName('  abc   TRADERS ')).toBe('abc traders');
    expect(normalizeClientName('Mr. Ahmed Ali')).toBe('ahmed ali');
    expect(normalizeClientName('Café & Co')).toBe('cafe');
    // A name made only of noise words still normalizes to something.
    expect(normalizeClientName('The Company')).toBe('the company');
  });

  it('normalizes national and international phone numbers to the same digits', () => {
    expect(normalizePhone('0300 1234567')).toBe('923001234567');
    expect(normalizePhone('+92 300-1234567')).toBe('923001234567');
    expect(normalizePhone('0092 300 1234567')).toBe('923001234567');
  });

  it('normalizes email case and whitespace', () => {
    expect(normalizeEmail('  Person@Example.TEST ')).toBe('person@example.test');
  });
});

describe('client create validation by type', () => {
  const contact = { name: 'Primary', email: 'primary@example.test', isPrimary: true };

  it('accepts an individual with a CNIC', () => {
    const parsed = ClientCreateRequestSchema.safeParse({
      type: 'individual',
      legalName: 'Test Individual',
      cnic: '35202-1234567-1',
      contacts: [contact],
      assignedManagerUserId: MANAGER_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it('requires a CNIC for an individual', () => {
    const parsed = ClientCreateRequestSchema.safeParse({
      type: 'individual',
      legalName: 'Test Individual',
      contacts: [],
      assignedManagerUserId: null,
    });
    expect(parsed.success).toBe(false);
    expect(issues(parsed)).toContain('cnic');
  });

  it('requires an NTN for a business and rejects a CNIC on it', () => {
    const missing = ClientCreateRequestSchema.safeParse({
      type: 'business',
      legalName: 'Test Business',
      contacts: [],
      assignedManagerUserId: null,
    });
    expect(issues(missing)).toContain('ntn');

    const withCnic = ClientCreateRequestSchema.safeParse({
      type: 'business',
      legalName: 'Test Business',
      ntn: '1234567-8',
      cnic: '35202-1234567-1',
      contacts: [],
      assignedManagerUserId: null,
    });
    expect(withCnic.success).toBe(false);
  });

  it('validates contacts: a channel each and at most one primary', () => {
    const noChannel = ClientCreateRequestSchema.safeParse({
      type: 'business',
      legalName: 'Test Business',
      ntn: '1234567',
      contacts: [{ name: 'Nobody', isPrimary: false }],
      assignedManagerUserId: null,
    });
    expect(issues(noChannel)).toContain('contacts.0.email');

    const twoPrimary = ClientCreateRequestSchema.safeParse({
      type: 'business',
      legalName: 'Test Business',
      ntn: '1234567',
      contacts: [contact, { ...contact, name: 'Second' }],
      assignedManagerUserId: null,
    });
    expect(issues(twoPrimary)).toContain('contacts');

    const badPhone = ClientCreateRequestSchema.safeParse({
      type: 'business',
      legalName: 'Test Business',
      ntn: '1234567',
      contacts: [{ name: 'Phone', phone: '12', isPrimary: false }],
      assignedManagerUserId: null,
    });
    expect(issues(badPhone)).toContain('contacts.0.phone');
  });

  it('requires a meaningful duplicate override reason when one is sent', () => {
    const parsed = ClientCreateRequestSchema.safeParse({
      type: 'business',
      legalName: 'Test Business',
      ntn: '1234567',
      contacts: [],
      assignedManagerUserId: null,
      duplicateOverrideReason: 'short',
    });
    expect(issues(parsed)).toContain('duplicateOverrideReason');
  });
});

describe('client update validation', () => {
  it('treats identifiers as write-only and optional', () => {
    const parsed = ClientUpdateRequestSchema.safeParse({
      type: 'individual',
      legalName: 'Test Individual',
      contacts: [],
      notes: '',
      assignedManagerUserId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('lets an individual clear their NTN but not a business', () => {
    expect(
      ClientUpdateRequestSchema.safeParse({
        type: 'individual',
        legalName: 'Test Individual',
        ntn: null,
        contacts: [],
        notes: '',
        assignedManagerUserId: null,
      }).success,
    ).toBe(true);
    expect(
      ClientUpdateRequestSchema.safeParse({
        type: 'business',
        legalName: 'Test Business',
        ntn: null,
        contacts: [],
        notes: '',
        assignedManagerUserId: null,
      }).success,
    ).toBe(false);
  });
});

describe('client list query', () => {
  it('hides archived clients by default and bounds the page size', () => {
    const parsed = ClientListQuerySchema.parse({});
    expect(parsed.state).toBe('active');
    expect(parsed.limit).toBe(25);
    expect(ClientListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('drops an empty search term', () => {
    expect(ClientListQuerySchema.parse({ q: '   ' }).q).toBeUndefined();
  });
});

describe('client permissions', () => {
  it('gives consultants assigned-only client visibility', () => {
    expect(roleHasPermission('consultant', 'clients.read')).toBe(true);
    expect(roleHasPermission('consultant', 'clients.read_all')).toBe(false);
    for (const role of ['administrator', 'manager', 'billing', 'read_only'] as const) {
      expect(roleHasPermission(role, 'clients.read_all')).toBe(true);
    }
  });

  it('limits client management to administrators and managers', () => {
    const managers = Object.values(ROLE_DEFINITIONS)
      .filter((definition) => definition.permissions.includes('clients.manage'))
      .map((definition) => definition.key)
      .sort();
    expect(managers).toEqual(['administrator', 'manager']);
  });
});

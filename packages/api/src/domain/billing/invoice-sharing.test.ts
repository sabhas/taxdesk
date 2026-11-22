import { describe, expect, it } from 'vitest';
import type { ClientContactRecord } from '../clients/types.js';
import { shareRecipientPhone } from './invoice-sharing.js';

const NOW = '2026-06-01T04:00:00.000Z';

function contact(
  position: number,
  phoneNormalized: string | null,
  isPrimary = false,
): ClientContactRecord {
  return {
    id: `0198a000-0000-7000-8000-00000000c00${String(position)}`,
    clientId: '0198a000-0000-7000-8000-0000000000c1',
    position,
    name: `Contact ${String(position)}`,
    relationship: null,
    email: null,
    emailNormalized: null,
    phone: phoneNormalized,
    phoneNormalized,
    isPrimary,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

describe('share recipient phone (TD-513)', () => {
  it('prefers the primary contact phone over earlier contacts', () => {
    expect(
      shareRecipientPhone([contact(1, '923001111111'), contact(2, '923002222222', true)]),
    ).toBe('923002222222');
  });

  it('falls back to the first contact with a usable phone', () => {
    expect(
      shareRecipientPhone([contact(1, null, true), contact(3, '923003333333'), contact(2, '12')]),
    ).toBe('923003333333');
  });

  it('returns null when no contact has a usable phone', () => {
    expect(shareRecipientPhone([contact(1, null, true), contact(2, '0300')])).toBeNull();
    expect(shareRecipientPhone([])).toBeNull();
  });
});

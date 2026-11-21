import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@taxdesk/shared';
import type { Actor } from '../auth/types.js';
import type { ClientRecord } from '../clients/types.js';
import { canManageBilling, canReadInvoiceTarget, type InvoiceTarget } from './billing-access.js';

/**
 * TD-511: a combined invoice is visible only to users who can see every
 * client on it. No built-in role reads billing without seeing every client,
 * so these use an actor whose client visibility is limited to assignment.
 */

const ME = '0198a000-0000-7000-8000-000000000001';
const SOMEONE_ELSE = '0198a000-0000-7000-8000-000000000002';

function actor(permissions: readonly PermissionKey[]): Actor {
  return {
    userId: ME,
    sessionId: '0198a000-0000-7000-8000-0000000000aa',
    roles: [],
    permissions: [...permissions],
  } as unknown as Actor;
}

function client(id: string, assignedManagerUserId: string | null): ClientRecord {
  return { id, assignedManagerUserId } as unknown as ClientRecord;
}

const head = client('0198a000-0000-7000-8000-0000000000c1', ME);
const visibleMember = client('0198a000-0000-7000-8000-0000000000c2', ME);
const hiddenMember = client('0198a000-0000-7000-8000-0000000000c3', SOMEONE_ELSE);

function combined(lineClients: readonly ClientRecord[]): InvoiceTarget {
  return { client: head, taxCase: null, lineClients, lineCases: [] };
}

describe('combined invoice visibility', () => {
  const restricted = actor(['clients.read', 'billing.read', 'billing.manage']);

  it('is readable when every line client is visible', () => {
    expect(canReadInvoiceTarget(restricted, combined([head, visibleMember]))).toBe(true);
    expect(canManageBilling(restricted, combined([head, visibleMember]))).toBe(true);
  });

  it('is hidden when any line client is not visible, even though the head is', () => {
    expect(canReadInvoiceTarget(restricted, combined([head, hiddenMember]))).toBe(false);
    expect(canManageBilling(restricted, combined([visibleMember, hiddenMember]))).toBe(false);
  });

  it('is readable by a user who sees every client', () => {
    const all = actor(['clients.read', 'clients.read_all', 'billing.read']);
    expect(canReadInvoiceTarget(all, combined([head, hiddenMember]))).toBe(true);
  });
});

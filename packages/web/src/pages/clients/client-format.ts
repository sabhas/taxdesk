import type {
  ClientActivityAction,
  ClientContact,
  ClientField,
  ClientType,
  DuplicateMatchReason,
} from '@taxdesk/shared';

export const CLIENT_TYPE_LABELS: Readonly<Record<ClientType, string>> = {
  individual: 'Individual',
  business: 'Business',
};

export const CLIENT_FIELD_LABELS: Readonly<Record<ClientField, string>> = {
  legalName: 'Legal name',
  displayName: 'Display name',
  cnic: 'CNIC',
  ntn: 'NTN',
  contacts: 'Contacts',
  notes: 'Notes',
  assignedManager: 'Assigned manager',
};

export const ACTIVITY_LABELS: Readonly<Record<ClientActivityAction, string>> = {
  'client.created': 'Created the client',
  'client.updated': 'Updated the client',
  'client.archived': 'Archived the client',
  'client.restored': 'Restored the client',
  'client.duplicate_override': 'Overrode a duplicate warning',
};

export const DUPLICATE_REASON_LABELS: Readonly<Record<DuplicateMatchReason, string>> = {
  cnic: 'same CNIC',
  ntn: 'same NTN',
  email: 'same email',
  phone: 'same phone',
  name: 'same name',
};

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function contactSummary(contact: ClientContact): string {
  return [contact.name, contact.email, contact.phone].filter((part) => part !== null).join(' · ');
}

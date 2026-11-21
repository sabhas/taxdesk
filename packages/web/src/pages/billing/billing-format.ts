import {
  FIRM_CURRENCY,
  formatMinorAmount,
  type BillingPdfState,
  type InvoiceStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '@taxdesk/shared';

import { ApiError } from '../../api-client.js';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline';

export function money(minor: number): string {
  return `${FIRM_CURRENCY} ${formatMinorAmount(minor)}`;
}

/** `150000` → `"1500.00"`: an editable major-unit string with no separators. */
export function toMajorInput(minor: number): string {
  return formatMinorAmount(minor).replace(/,/gu, '');
}

export function formatDate(date: string | null): string {
  if (date === null) return '—';
  const [year, month, day] = date.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

export const INVOICE_STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  draft: 'Draft',
  finalized: 'Finalized',
  void: 'Void',
};

export const INVOICE_STATUS_BADGE: Readonly<Record<InvoiceStatus, BadgeVariant>> = {
  draft: 'outline',
  finalized: 'default',
  void: 'secondary',
};

export const PAYMENT_STATUS_LABELS: Readonly<Record<PaymentStatus, string>> = {
  unpaid: 'Unpaid',
  partially_paid: 'Partly paid',
  paid: 'Paid',
};

export const PAYMENT_STATUS_BADGE: Readonly<Record<PaymentStatus, BadgeVariant>> = {
  unpaid: 'warning',
  partially_paid: 'warning',
  paid: 'success',
};

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

export const PDF_STATE_LABELS: Readonly<Record<BillingPdfState, string>> = {
  none: 'No PDF yet',
  pending: 'PDF is being prepared',
  ready: 'PDF ready',
  failed: 'PDF could not be stored',
};

/** The draft editor's per-line error keys for each line field the API names. */
const LINE_FIELD_KEYS: Readonly<Record<string, string>> = {
  description: 'd',
  quantity: 'q',
  unitAmountMinor: 'u',
  clientId: 'c',
  caseId: 'k',
};

/**
 * Line errors from an API failure, keyed as the draft editor keys them (for
 * example `items.2.clientId` → `c2`). `null` when the failure names no line, so
 * the caller shows only its page notice.
 */
export function invoiceLineErrors(error: unknown): ReadonlyMap<string, string> | null {
  if (!(error instanceof ApiError)) return null;
  const errors = new Map<string, string>();
  for (const { field, message } of error.fieldErrors) {
    const match = /^items\.(\d+)\.(\w+)$/u.exec(field);
    const key = match === null ? undefined : LINE_FIELD_KEYS[match[2] ?? ''];
    if (match !== null && key !== undefined) {
      errors.set(`${key}${match[1] ?? ''}`, message);
    }
  }
  return errors.size === 0 ? null : errors;
}

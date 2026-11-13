import {
  FIRM_CURRENCY,
  formatMinorAmount,
  type BillingPdfState,
  type InvoiceStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '@taxdesk/shared';

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

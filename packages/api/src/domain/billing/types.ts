import type {
  BillingPdfState,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  StorageProviderType,
} from '@taxdesk/shared';

export interface InvoiceRecord {
  readonly id: string;
  readonly clientId: string;
  /** Read-only join fields, never written. */
  readonly clientCode: string;
  readonly clientDisplayName: string;
  readonly caseId: string | null;
  readonly caseCode: string | null;
  readonly caseServiceName: string | null;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly invoiceNumber: string | null;
  /** Calendar dates, `YYYY-MM-DD`. */
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly outstandingMinor: number;
  readonly paymentStatus: PaymentStatus;
  readonly notes: string;
  readonly finalizedAt: string | null;
  readonly finalizedBy: string | null;
  readonly voidReason: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: string | null;
  readonly pdfState: BillingPdfState;
  readonly pdfDocumentId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface InvoiceItemRecord {
  readonly id: string;
  readonly invoiceId: string;
  readonly position: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmountMinor: number;
  readonly lineTotalMinor: number;
  readonly createdAt: string;
}

/** A draft's editable content; the repository bumps `version` and `updatedAt`. */
export interface InvoiceDraftChanges {
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly outstandingMinor: number;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly notes: string;
}

export interface InvoiceFinalization {
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly finalizedAt: string;
  readonly finalizedBy: string;
}

export interface InvoiceVoiding {
  readonly reason: string;
  readonly voidedAt: string;
  readonly voidedBy: string;
}

export interface InvoiceBalance {
  readonly paidMinor: number;
  readonly outstandingMinor: number;
  readonly paymentStatus: PaymentStatus;
}

export interface InvoiceListCursor {
  /** `created_at` of the last row of the previous page. */
  readonly createdAt: string;
  readonly id: string;
}

export interface InvoiceListFilter {
  readonly clientId?: string;
  readonly caseId?: string;
  readonly status?: InvoiceStatus;
  readonly paymentStatus?: PaymentStatus;
  readonly issuedFrom?: string;
  readonly issuedTo?: string;
  readonly dueFrom?: string;
  readonly dueTo?: string;
  /** Visibility restriction when the actor cannot read every client. */
  readonly visibleClientIds?: readonly string[];
  readonly limit: number;
  readonly after: InvoiceListCursor | null;
}

export interface InvoiceListPage {
  readonly invoices: readonly InvoiceRecord[];
  /** `limit + 1` rows are fetched so the service can tell whether more exist. */
  readonly hasMore: boolean;
}

export interface PaymentRecord {
  readonly id: string;
  readonly invoiceId: string;
  readonly receiptNumber: string;
  readonly amountMinor: number;
  readonly method: PaymentMethod;
  readonly receivedOn: string;
  readonly reference: string;
  readonly recordedBy: string;
  readonly receiptPdfState: BillingPdfState;
  readonly receiptDocumentId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface PaymentReversalRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountMinor: number;
  readonly reason: string;
  readonly reversedBy: string;
  readonly createdAt: string;
}

export interface BillingDocumentRecord {
  readonly id: string;
  readonly kind: 'invoice' | 'receipt';
  readonly invoiceId: string;
  readonly paymentId: string | null;
  readonly clientId: string;
  readonly caseId: string | null;
  readonly providerType: StorageProviderType;
  /** Durable provider-neutral reference. Never a path. */
  readonly externalItemId: string;
  readonly externalDriveId: string | null;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export type IdempotencyBegin =
  | { readonly kind: 'new' }
  /** The same key and request already completed; return its stored response. */
  | { readonly kind: 'replay'; readonly response: unknown }
  /** The key was used earlier for a different request. */
  | { readonly kind: 'conflict' };

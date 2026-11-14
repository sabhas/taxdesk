import {
  BillingPdfResultSchema,
  InvoiceListSchema,
  InvoiceSchema,
  PaymentListSchema,
  PaymentOutcomeSchema,
  type BillingPdfResult,
  type Invoice,
  type InvoiceDraftCreateRequest,
  type InvoiceDraftUpdateRequest,
  type InvoiceList,
  type InvoiceStatus,
  type PaymentList,
  type PaymentOutcome,
  type PaymentStatus,
  type RecordPaymentRequest,
  type ReversePaymentRequest,
  type VoidInvoiceRequest,
} from '@taxdesk/shared';
import { apiRequest } from './api-client.js';

/**
 * Billing clients (Epic 5). The API enforces every rule and recomputes every
 * total; these only shape requests. Financial commands take an idempotency key
 * that the caller keeps for the lifetime of one dialog.
 */

export interface InvoiceFilters {
  readonly clientId?: string;
  readonly caseId?: string;
  readonly status?: InvoiceStatus;
  readonly paymentStatus?: PaymentStatus;
  readonly issuedFrom?: string;
  readonly issuedTo?: string;
  readonly dueFrom?: string;
  readonly dueTo?: string;
  /** Dashboard drill-downs: finalized invoices with a balance, or past due. */
  readonly balance?: 'outstanding' | 'overdue';
  readonly limit?: number;
  readonly cursor?: string;
}

function signalOption(signal: AbortSignal | undefined) {
  return signal === undefined ? {} : { signal };
}

function invoiceUrl(id: string, suffix = ''): string {
  return `/api/v1/invoices/${encodeURIComponent(id)}${suffix}`;
}

export async function listInvoices(
  filters: InvoiceFilters,
  signal?: AbortSignal,
): Promise<InvoiceList> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(name, String(value));
  }
  return await apiRequest(`/api/v1/invoices?${query.toString()}`, InvoiceListSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function getInvoice(id: string, signal?: AbortSignal): Promise<Invoice> {
  return await apiRequest(invoiceUrl(id), InvoiceSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function createInvoiceDraft(request: InvoiceDraftCreateRequest): Promise<Invoice> {
  return await apiRequest('/api/v1/invoices', InvoiceSchema, {
    method: 'POST',
    body: request,
    sessionScoped: true,
  });
}

export async function updateInvoiceDraft(
  id: string,
  request: InvoiceDraftUpdateRequest,
  version: number,
): Promise<Invoice> {
  return await apiRequest(invoiceUrl(id), InvoiceSchema, {
    method: 'PATCH',
    body: request,
    ifMatch: version,
    sessionScoped: true,
  });
}

export async function finalizeInvoice(
  id: string,
  version: number,
  idempotencyKey: string,
): Promise<Invoice> {
  return await apiRequest(invoiceUrl(id, '/finalize'), InvoiceSchema, {
    method: 'POST',
    ifMatch: version,
    idempotencyKey,
    sessionScoped: true,
  });
}

export async function voidInvoice(
  id: string,
  version: number,
  request: VoidInvoiceRequest,
  idempotencyKey: string,
): Promise<Invoice> {
  return await apiRequest(invoiceUrl(id, '/void'), InvoiceSchema, {
    method: 'POST',
    body: request,
    ifMatch: version,
    idempotencyKey,
    sessionScoped: true,
  });
}

export async function listPayments(id: string, signal?: AbortSignal): Promise<PaymentList> {
  return await apiRequest(invoiceUrl(id, '/payments'), PaymentListSchema, {
    sessionScoped: true,
    ...signalOption(signal),
  });
}

export async function recordPayment(
  invoiceId: string,
  request: RecordPaymentRequest,
  idempotencyKey: string,
): Promise<PaymentOutcome> {
  return await apiRequest(invoiceUrl(invoiceId, '/payments'), PaymentOutcomeSchema, {
    method: 'POST',
    body: request,
    idempotencyKey,
    sessionScoped: true,
  });
}

export async function reversePayment(
  paymentId: string,
  request: ReversePaymentRequest,
  idempotencyKey: string,
): Promise<PaymentOutcome> {
  return await apiRequest(
    `/api/v1/payments/${encodeURIComponent(paymentId)}/reverse`,
    PaymentOutcomeSchema,
    { method: 'POST', body: request, idempotencyKey, sessionScoped: true },
  );
}

export async function generateInvoicePdf(id: string): Promise<BillingPdfResult> {
  return await apiRequest(invoiceUrl(id, '/pdf'), BillingPdfResultSchema, {
    method: 'POST',
    sessionScoped: true,
  });
}

export async function generateReceiptPdf(paymentId: string): Promise<BillingPdfResult> {
  return await apiRequest(
    `/api/v1/payments/${encodeURIComponent(paymentId)}/receipt-pdf`,
    BillingPdfResultSchema,
    { method: 'POST', sessionScoped: true },
  );
}

/** Same-origin download URLs; the API rechecks access and audits each download. */
export function invoicePdfPath(id: string): string {
  return invoiceUrl(id, '/pdf');
}

export function receiptPdfPath(paymentId: string): string {
  return `/api/v1/payments/${encodeURIComponent(paymentId)}/receipt-pdf`;
}

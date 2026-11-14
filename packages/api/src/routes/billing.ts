import { Hono, type Context } from 'hono';
import { type z } from 'zod';
import {
  BillingPdfResultSchema,
  InvoiceDraftCreateRequestSchema,
  InvoiceDraftUpdateRequestSchema,
  InvoiceListQuerySchema,
  InvoiceListSchema,
  InvoiceSchema,
  PaymentListSchema,
  PaymentOutcomeSchema,
  RecordPaymentRequestSchema,
  ReversePaymentRequestSchema,
  UuidSchema,
  VoidInvoiceRequestSchema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { AuthError } from '../domain/auth/errors.js';
import { protect } from '../middleware/auth.js';
import {
  parseJsonBody,
  requireIdempotencyKey,
  requireIfMatch,
  setEtag,
} from '../transport/request.js';

/**
 * Invoice, payment, and billing-PDF routes (TD-502–TD-509). Routes parse and
 * map only; every authorization and financial rule lives in `BillingService`
 * and `BillingDocumentService`. Financial commands need an `Idempotency-Key`,
 * and a retry returns the stored outcome with status 200.
 */
export const billingRoutes = new Hono<AppEnv>();

const read = () => protect({ access: 'any_permission', permissions: ['billing.read'] });
const manage = () => protect({ access: 'permission', permission: 'billing.manage' });
const reverse = () => protect({ access: 'permission', permission: 'billing.payments.reverse' });

function invoiceId(c: Context<AppEnv>): string {
  const value = c.req.param('invoiceId') ?? '';
  if (!UuidSchema.safeParse(value).success) {
    throw new AuthError(404, 'INVOICE_NOT_FOUND', 'The requested invoice was not found.');
  }
  return value;
}

function paymentId(c: Context<AppEnv>): string {
  const value = c.req.param('paymentId') ?? '';
  if (!UuidSchema.safeParse(value).success) {
    throw new AuthError(404, 'PAYMENT_NOT_FOUND', 'The requested payment was not found.');
  }
  return value;
}

function parseQuery<T>(c: Context<AppEnv>, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AuthError(400, 'VALIDATION_FAILED', 'Check the invoice filters.', {
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.length === 0 ? 'query' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function noStore(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'no-store');
}

function pdfResponse(
  c: Context<AppEnv>,
  fileName: string,
  download: { readonly body: ReadableStream<Uint8Array>; readonly sizeBytes: number | null },
): Response {
  c.header('Content-Type', 'application/pdf');
  c.header('Content-Disposition', `attachment; filename="${fileName}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', 'sandbox');
  if (download.sizeBytes !== null) {
    c.header('Content-Length', String(download.sizeBytes));
  }
  return c.body(download.body, 200);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

billingRoutes.post('/invoices', manage(), async (c) => {
  const request = await parseJsonBody(c, InvoiceDraftCreateRequestSchema);
  const invoice = await c.get('dependencies').billingService.createDraft({
    actor: c.get('actor'),
    request,
    requestId: c.get('requestId'),
  });
  setEtag(c, invoice.version);
  noStore(c);
  return c.json(InvoiceSchema.parse(invoice), 201);
});

billingRoutes.get('/invoices', read(), async (c) => {
  const query = parseQuery(c, InvoiceListQuerySchema);
  const list = await c.get('dependencies').billingService.listInvoices(c.get('actor'), query);
  noStore(c);
  return c.json(InvoiceListSchema.parse(list));
});

billingRoutes.get('/invoices/:invoiceId', read(), async (c) => {
  const invoice = await c
    .get('dependencies')
    .billingService.getInvoice(c.get('actor'), invoiceId(c));
  setEtag(c, invoice.version);
  noStore(c);
  return c.json(InvoiceSchema.parse(invoice));
});

billingRoutes.patch('/invoices/:invoiceId', manage(), async (c) => {
  const id = invoiceId(c);
  const expectedVersion = requireIfMatch(c);
  const request = await parseJsonBody(c, InvoiceDraftUpdateRequestSchema);
  const invoice = await c.get('dependencies').billingService.updateDraft({
    actor: c.get('actor'),
    id,
    request,
    expectedVersion,
    requestId: c.get('requestId'),
  });
  setEtag(c, invoice.version);
  return c.json(InvoiceSchema.parse(invoice));
});

billingRoutes.post('/invoices/:invoiceId/finalize', manage(), async (c) => {
  const id = invoiceId(c);
  const expectedVersion = requireIfMatch(c);
  const idempotencyKey = requireIdempotencyKey(c);
  const dependencies = c.get('dependencies');
  const actor = c.get('actor');
  const requestId = c.get('requestId');
  const { value, replayed } = await dependencies.billingService.finalizeInvoice({
    actor,
    id,
    expectedVersion,
    idempotencyKey,
    requestId,
  });
  let invoice = value;
  if (!replayed) {
    // The invoice is committed. A PDF failure never undoes it: the invoice
    // shows a failed state and a retry action instead.
    await dependencies.billingDocumentService.generateInvoicePdf({
      actor,
      invoiceId: id,
      requestId,
      mode: 'best_effort',
    });
    invoice = await dependencies.billingService.getInvoice(actor, id);
  }
  setEtag(c, invoice.version);
  return c.json(InvoiceSchema.parse(invoice), 200);
});

billingRoutes.post('/invoices/:invoiceId/void', manage(), async (c) => {
  const id = invoiceId(c);
  const expectedVersion = requireIfMatch(c);
  const idempotencyKey = requireIdempotencyKey(c);
  const request = await parseJsonBody(c, VoidInvoiceRequestSchema);
  const { value } = await c.get('dependencies').billingService.voidInvoice({
    actor: c.get('actor'),
    id,
    request,
    expectedVersion,
    idempotencyKey,
    requestId: c.get('requestId'),
  });
  setEtag(c, value.version);
  return c.json(InvoiceSchema.parse(value), 200);
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

billingRoutes.get('/invoices/:invoiceId/payments', read(), async (c) => {
  const list = await c
    .get('dependencies')
    .billingService.listPayments(c.get('actor'), invoiceId(c));
  noStore(c);
  return c.json(PaymentListSchema.parse(list));
});

billingRoutes.post('/invoices/:invoiceId/payments', manage(), async (c) => {
  const id = invoiceId(c);
  const idempotencyKey = requireIdempotencyKey(c);
  const request = await parseJsonBody(c, RecordPaymentRequestSchema);
  const dependencies = c.get('dependencies');
  const actor = c.get('actor');
  const requestId = c.get('requestId');
  const { value, replayed } = await dependencies.billingService.recordPayment({
    actor,
    invoiceId: id,
    request,
    idempotencyKey,
    requestId,
  });
  let outcome = value;
  if (!replayed) {
    await dependencies.billingDocumentService.generateReceiptPdf({
      actor,
      paymentId: value.payment.id,
      requestId,
      mode: 'best_effort',
    });
    outcome = await dependencies.billingService.getPaymentOutcome(actor, value.payment.id);
  }
  setEtag(c, outcome.invoice.version);
  return c.json(PaymentOutcomeSchema.parse(outcome), replayed ? 200 : 201);
});

billingRoutes.post('/payments/:paymentId/reverse', reverse(), async (c) => {
  const id = paymentId(c);
  const idempotencyKey = requireIdempotencyKey(c);
  const request = await parseJsonBody(c, ReversePaymentRequestSchema);
  const { value } = await c.get('dependencies').billingService.reversePayment({
    actor: c.get('actor'),
    paymentId: id,
    request,
    idempotencyKey,
    requestId: c.get('requestId'),
  });
  setEtag(c, value.invoice.version);
  return c.json(PaymentOutcomeSchema.parse(value), 200);
});

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

billingRoutes.post('/invoices/:invoiceId/pdf', manage(), async (c) => {
  const result = await c.get('dependencies').billingDocumentService.generateInvoicePdf({
    actor: c.get('actor'),
    invoiceId: invoiceId(c),
    requestId: c.get('requestId'),
    mode: 'explicit',
  });
  return c.json(BillingPdfResultSchema.parse({ pdfState: result.state, created: result.created }));
});

billingRoutes.get('/invoices/:invoiceId/pdf', read(), async (c) => {
  const { fileName, download } = await c
    .get('dependencies')
    .billingDocumentService.downloadInvoicePdf({
      actor: c.get('actor'),
      invoiceId: invoiceId(c),
      requestId: c.get('requestId'),
    });
  return pdfResponse(c, fileName, download);
});

billingRoutes.post('/payments/:paymentId/receipt-pdf', manage(), async (c) => {
  const result = await c.get('dependencies').billingDocumentService.generateReceiptPdf({
    actor: c.get('actor'),
    paymentId: paymentId(c),
    requestId: c.get('requestId'),
    mode: 'explicit',
  });
  return c.json(BillingPdfResultSchema.parse({ pdfState: result.state, created: result.created }));
});

billingRoutes.get('/payments/:paymentId/receipt-pdf', read(), async (c) => {
  const { fileName, download } = await c
    .get('dependencies')
    .billingDocumentService.downloadReceiptPdf({
      actor: c.get('actor'),
      paymentId: paymentId(c),
      requestId: c.get('requestId'),
    });
  return pdfResponse(c, fileName, download);
});

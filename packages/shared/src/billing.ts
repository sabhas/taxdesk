import { z } from 'zod';
import { IsoDateSchema } from './case.js';
import { UuidSchema, UuidV7Schema } from './id.js';
import { FIRM_CURRENCY, MinorAmountSchema, SERVICE_TYPE_LIMITS } from './service-type.js';

/**
 * Billing contracts (Epic 5). Money is an integer count of minor units. The
 * server always recomputes totals from the line items; a client may preview
 * with `calculateInvoiceTotals` but never sends a total.
 */

export const INVOICE_LIMITS = {
  descriptionMax: 300,
  notesMax: 2000,
  referenceMax: 120,
  reasonMax: 500,
  itemsMax: 50,
  quantityMax: 100_000,
} as const;

export const INVOICE_STATUSES = ['draft', 'finalized', 'void'] as const;
export const InvoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid'] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'card', 'other'] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

/** Generation state of a stored invoice or receipt PDF. */
export const BILLING_PDF_STATES = ['none', 'pending', 'ready', 'failed'] as const;
export const BillingPdfStateSchema = z.enum(BILLING_PDF_STATES);
export type BillingPdfState = z.infer<typeof BillingPdfStateSchema>;

export const INVOICE_NUMBER_PATTERN = /^INV-\d{5,}$/u;
export const RECEIPT_NUMBER_PATTERN = /^RCP-\d{5,}$/u;

export function formatInvoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(5, '0')}`;
}

export function formatReceiptNumber(sequence: number): string {
  return `RCP-${String(sequence).padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export const InvoiceItemInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1, 'Enter a description.')
      .max(INVOICE_LIMITS.descriptionMax, 'Use a shorter description.'),
    quantity: z
      .number()
      .int('Use a whole quantity.')
      .min(1, 'The quantity must be at least 1.')
      .max(INVOICE_LIMITS.quantityMax, 'The quantity is too large.'),
    unitAmountMinor: MinorAmountSchema,
  })
  .strict();

export type InvoiceItemInput = z.infer<typeof InvoiceItemInputSchema>;

export interface InvoiceTotals {
  readonly lineTotalsMinor: readonly number[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
}

export type InvoiceTotalsResult =
  | { readonly ok: true; readonly totals: InvoiceTotals }
  | { readonly ok: false; readonly field: string; readonly message: string };

/**
 * Pure invoice arithmetic shared by the server (authoritative) and the browser
 * (preview). Every amount stays a safe integer below the firm-wide ceiling, so
 * no step can overflow or go negative.
 */
export function calculateInvoiceTotals(
  items: readonly InvoiceItemInput[],
  discountMinor: number,
): InvoiceTotalsResult {
  const ceiling = SERVICE_TYPE_LIMITS.feeMaxMinor;
  if (items.length > INVOICE_LIMITS.itemsMax) {
    return { ok: false, field: 'items', message: 'Too many line items.' };
  }
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) {
    return { ok: false, field: 'discountMinor', message: 'The discount cannot be negative.' };
  }
  const lineTotalsMinor: number[] = [];
  let subtotalMinor = 0;
  for (const [index, item] of items.entries()) {
    const { quantity, unitAmountMinor } = item;
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      !Number.isSafeInteger(unitAmountMinor) ||
      unitAmountMinor < 0
    ) {
      return {
        ok: false,
        field: `items.${String(index)}`,
        message: 'The line item is malformed.',
      };
    }
    const line = quantity * unitAmountMinor;
    if (!Number.isSafeInteger(line) || line > ceiling) {
      return {
        ok: false,
        field: `items.${String(index)}.unitAmountMinor`,
        message: 'The line total is too large.',
      };
    }
    lineTotalsMinor.push(line);
    subtotalMinor += line;
    if (subtotalMinor > ceiling) {
      return { ok: false, field: 'items', message: 'The invoice subtotal is too large.' };
    }
  }
  if (discountMinor > subtotalMinor) {
    return {
      ok: false,
      field: 'discountMinor',
      message: 'The discount cannot be more than the subtotal.',
    };
  }
  return {
    ok: true,
    totals: {
      lineTotalsMinor,
      subtotalMinor,
      discountMinor,
      totalMinor: subtotalMinor - discountMinor,
    },
  };
}

/** Derives payment status from net paid and total. */
export function paymentStatusFor(totalMinor: number, paidMinor: number): PaymentStatus {
  if (paidMinor <= 0) {
    return 'unpaid';
  }
  return paidMinor >= totalMinor ? 'paid' : 'partially_paid';
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const noteField = z.string().trim().max(INVOICE_LIMITS.notesMax, 'Use shorter notes.');
const reasonField = z
  .string()
  .trim()
  .min(1, 'Enter a reason.')
  .max(INVOICE_LIMITS.reasonMax, 'Use a shorter reason.');

/** Start a draft from a case (default line = its service) or manually from a client. */
export const InvoiceDraftCreateRequestSchema = z
  .object({
    clientId: UuidV7Schema.optional(),
    caseId: UuidV7Schema.optional(),
  })
  .strict()
  .refine((value) => (value.clientId === undefined) !== (value.caseId === undefined), {
    message: 'Send either a client or a case.',
    path: ['clientId'],
  });

export type InvoiceDraftCreateRequest = z.infer<typeof InvoiceDraftCreateRequestSchema>;

/** Full replacement of a draft's editable content; the item list is the new order. */
export const InvoiceDraftUpdateRequestSchema = z
  .object({
    items: z.array(InvoiceItemInputSchema).max(INVOICE_LIMITS.itemsMax, 'Too many line items.'),
    discountMinor: MinorAmountSchema,
    issueDate: IsoDateSchema.nullable(),
    dueDate: IsoDateSchema.nullable(),
    notes: noteField,
  })
  .strict()
  .refine(
    (value) =>
      value.issueDate === null || value.dueDate === null || value.dueDate >= value.issueDate,
    { message: 'The due date cannot be before the issue date.', path: ['dueDate'] },
  );

export type InvoiceDraftUpdateRequest = z.infer<typeof InvoiceDraftUpdateRequestSchema>;

export const InvoiceItemSchema = z
  .object({
    id: UuidSchema,
    position: z.number().int().min(1),
    description: z.string().min(1).max(INVOICE_LIMITS.descriptionMax),
    quantity: z.number().int().min(1),
    unitAmountMinor: MinorAmountSchema,
    lineTotalMinor: MinorAmountSchema,
  })
  .strict();

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

const InvoiceClientSchema = z
  .object({ id: UuidSchema, clientCode: z.string(), displayName: z.string() })
  .strict();

const InvoiceCaseSchema = z
  .object({ id: UuidSchema, caseCode: z.string(), serviceName: z.string() })
  .strict();

const invoiceSummaryFields = {
  id: UuidSchema,
  invoiceNumber: z.string().regex(INVOICE_NUMBER_PATTERN).nullable(),
  status: InvoiceStatusSchema,
  paymentStatus: PaymentStatusSchema,
  currency: z.literal(FIRM_CURRENCY),
  client: InvoiceClientSchema,
  case: InvoiceCaseSchema.nullable(),
  issueDate: IsoDateSchema.nullable(),
  dueDate: IsoDateSchema.nullable(),
  subtotalMinor: MinorAmountSchema,
  discountMinor: MinorAmountSchema,
  totalMinor: MinorAmountSchema,
  paidMinor: MinorAmountSchema,
  outstandingMinor: MinorAmountSchema,
  pdfState: BillingPdfStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
};

export const InvoiceSummarySchema = z.object(invoiceSummaryFields).strict();
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

export const InvoiceSchema = z
  .object({
    ...invoiceSummaryFields,
    items: z.array(InvoiceItemSchema),
    notes: z.string().max(INVOICE_LIMITS.notesMax),
    finalizedAt: z.string().datetime().nullable(),
    voidReason: z.string().max(INVOICE_LIMITS.reasonMax).nullable(),
    voidedAt: z.string().datetime().nullable(),
  })
  .strict();

export type Invoice = z.infer<typeof InvoiceSchema>;

export const INVOICE_LIST_LIMITS = { defaultLimit: 25, maxLimit: 100 } as const;

const optionalUuid = UuidV7Schema.optional();

export const InvoiceListQuerySchema = z
  .object({
    clientId: optionalUuid,
    caseId: optionalUuid,
    status: InvoiceStatusSchema.optional(),
    paymentStatus: PaymentStatusSchema.optional(),
    issuedFrom: IsoDateSchema.optional(),
    issuedTo: IsoDateSchema.optional(),
    dueFrom: IsoDateSchema.optional(),
    dueTo: IsoDateSchema.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INVOICE_LIST_LIMITS.maxLimit)
      .default(INVOICE_LIST_LIMITS.defaultLimit),
  })
  .strict();

export type InvoiceListQuery = z.infer<typeof InvoiceListQuerySchema>;

export const InvoiceListSchema = z
  .object({
    invoices: z.array(InvoiceSummarySchema),
    nextCursor: z.string().min(1).max(256).nullable(),
  })
  .strict();

export type InvoiceList = z.infer<typeof InvoiceListSchema>;

// ---------------------------------------------------------------------------
// Payments, reversals, void
// ---------------------------------------------------------------------------

export const RecordPaymentRequestSchema = z
  .object({
    amountMinor: MinorAmountSchema.refine((value) => value > 0, 'Enter an amount above zero.'),
    method: PaymentMethodSchema,
    receivedOn: IsoDateSchema,
    reference: z
      .string()
      .trim()
      .max(INVOICE_LIMITS.referenceMax, 'Use a shorter reference.')
      .default(''),
  })
  .strict();

export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequestSchema>;

export const ReversePaymentRequestSchema = z
  .object({
    amountMinor: MinorAmountSchema.refine((value) => value > 0, 'Enter an amount above zero.'),
    reason: reasonField,
  })
  .strict();

export type ReversePaymentRequest = z.infer<typeof ReversePaymentRequestSchema>;

export const VoidInvoiceRequestSchema = z
  .object({
    reason: reasonField,
    confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm the void.' }) }),
  })
  .strict();

export type VoidInvoiceRequest = z.infer<typeof VoidInvoiceRequestSchema>;

export const PaymentReversalSchema = z
  .object({
    id: UuidSchema,
    amountMinor: MinorAmountSchema,
    reason: z.string().min(1).max(INVOICE_LIMITS.reasonMax),
    reversedByName: z.string().nullable(),
    reversedAt: z.string().datetime(),
  })
  .strict();

export type PaymentReversal = z.infer<typeof PaymentReversalSchema>;

export const PaymentSchema = z
  .object({
    id: UuidSchema,
    invoiceId: UuidSchema,
    receiptNumber: z.string().regex(RECEIPT_NUMBER_PATTERN),
    amountMinor: MinorAmountSchema,
    method: PaymentMethodSchema,
    receivedOn: IsoDateSchema,
    reference: z.string().max(INVOICE_LIMITS.referenceMax),
    recordedByName: z.string().nullable(),
    recordedAt: z.string().datetime(),
    reversedMinor: MinorAmountSchema,
    reversals: z.array(PaymentReversalSchema),
    receiptPdfState: BillingPdfStateSchema,
  })
  .strict();

export type Payment = z.infer<typeof PaymentSchema>;

export const PaymentListSchema = z.object({ payments: z.array(PaymentSchema) }).strict();
export type PaymentList = z.infer<typeof PaymentListSchema>;

/** Result of a payment or reversal: the payment and the invoice's new balance. */
export const PaymentOutcomeSchema = z
  .object({ payment: PaymentSchema, invoice: InvoiceSchema })
  .strict();

export type PaymentOutcome = z.infer<typeof PaymentOutcomeSchema>;

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

/** Outcome of an explicit PDF generation (retry) request. */
export const BillingPdfResultSchema = z
  .object({ pdfState: BillingPdfStateSchema, created: z.boolean() })
  .strict();

export type BillingPdfResult = z.infer<typeof BillingPdfResultSchema>;

import { z } from 'zod';
import { IsoDateSchema } from './case.js';
import { UuidSchema, UuidV7Schema } from './id.js';
import {
  FIRM_CURRENCY,
  MinorAmountSchema,
  SERVICE_TYPE_LIMITS,
  formatMinorAmount,
} from './service-type.js';

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

/**
 * How an invoice is addressed (TD-511). `individual` bills one client (and
 * optionally one of its cases). `combined` bills a group head for work done
 * for the head and its members: each line names the client it is for.
 */
export const INVOICE_BILLING_MODES = ['individual', 'combined'] as const;
export const InvoiceBillingModeSchema = z.enum(INVOICE_BILLING_MODES);
export type InvoiceBillingMode = z.infer<typeof InvoiceBillingModeSchema>;

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

/**
 * Numbers carry the firm's prefix at the time they were issued (TD-605), so
 * the pattern accepts any 2-6 letter prefix. A prefix change never rewrites an
 * issued number.
 */
export const INVOICE_NUMBER_PATTERN = /^[A-Z]{2,6}-\d{5,}$/u;
export const RECEIPT_NUMBER_PATTERN = /^[A-Z]{2,6}-\d{5,}$/u;

export function formatInvoiceNumber(sequence: number, prefix = 'INV'): string {
  return `${prefix}-${String(sequence).padStart(5, '0')}`;
}

export function formatReceiptNumber(sequence: number, prefix = 'RCP'): string {
  return `${prefix}-${String(sequence).padStart(5, '0')}`;
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
    /**
     * Combined invoices only (TD-511): the client the line is for, either the
     * group head or a current member. Required on a combined invoice and
     * rejected on an individual one.
     */
    clientId: UuidV7Schema.optional(),
    /** Combined invoices only: one of the line client's cases. */
    caseId: UuidV7Schema.optional(),
  })
  .strict()
  .refine((value) => value.caseId === undefined || value.clientId !== undefined, {
    message: 'Choose the client before the case.',
    path: ['caseId'],
  });

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

/**
 * Start a draft from a case (default line = its service) or manually from a
 * client. `billingMode: 'combined'` (TD-511) starts an empty combined group
 * invoice addressed to a group head, so it needs a client and no case.
 */
export const InvoiceDraftCreateRequestSchema = z
  .object({
    clientId: UuidV7Schema.optional(),
    caseId: UuidV7Schema.optional(),
    billingMode: InvoiceBillingModeSchema.optional(),
  })
  .strict()
  .refine((value) => (value.clientId === undefined) !== (value.caseId === undefined), {
    message: 'Send either a client or a case.',
    path: ['clientId'],
  })
  .refine((value) => value.billingMode !== 'combined' || value.caseId === undefined, {
    message: 'A combined invoice is created from the group head client, not from a case.',
    path: ['caseId'],
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

const InvoiceClientSchema = z
  .object({ id: UuidSchema, clientCode: z.string(), displayName: z.string() })
  .strict();

const InvoiceCaseSchema = z
  .object({ id: UuidSchema, caseCode: z.string(), serviceName: z.string() })
  .strict();

export const InvoiceItemSchema = z
  .object({
    id: UuidSchema,
    position: z.number().int().min(1),
    description: z.string().min(1).max(INVOICE_LIMITS.descriptionMax),
    quantity: z.number().int().min(1),
    unitAmountMinor: MinorAmountSchema,
    lineTotalMinor: MinorAmountSchema,
    /**
     * Combined invoices only (TD-511): the client the line is for. On a
     * finalized invoice the code and name are the snapshot taken at
     * finalization, so a later group or name change never alters them.
     * `null` on individual invoices.
     */
    client: InvoiceClientSchema.nullable(),
    /** Combined invoices only: the line's case, when one was chosen. */
    case: InvoiceCaseSchema.nullable(),
  })
  .strict();

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

const invoiceSummaryFields = {
  id: UuidSchema,
  invoiceNumber: z.string().regex(INVOICE_NUMBER_PATTERN).nullable(),
  status: InvoiceStatusSchema,
  paymentStatus: PaymentStatusSchema,
  billingMode: InvoiceBillingModeSchema,
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  version: z.number().int().positive(),
};

export const InvoiceSummarySchema = z.object(invoiceSummaryFields).strict();
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

export const InvoiceSchema = z
  .object({
    ...invoiceSummaryFields,
    items: z.array(InvoiceItemSchema),
    notes: z.string().max(INVOICE_LIMITS.notesMax),
    finalizedAt: z.iso.datetime().nullable(),
    voidReason: z.string().max(INVOICE_LIMITS.reasonMax).nullable(),
    voidedAt: z.iso.datetime().nullable(),
  })
  .strict();

export type Invoice = z.infer<typeof InvoiceSchema>;

export const INVOICE_LIST_LIMITS = { defaultLimit: 25, maxLimit: 100 } as const;

const optionalUuid = UuidV7Schema.optional();

export const InvoiceListQuerySchema = z
  .object({
    clientId: optionalUuid,
    /** A group head's client ID: invoices of the head and its members (TD-207). */
    group: optionalUuid,
    caseId: optionalUuid,
    status: InvoiceStatusSchema.optional(),
    paymentStatus: PaymentStatusSchema.optional(),
    issuedFrom: IsoDateSchema.optional(),
    issuedTo: IsoDateSchema.optional(),
    dueFrom: IsoDateSchema.optional(),
    dueTo: IsoDateSchema.optional(),
    /**
     * `outstanding`: finalized invoices with a balance; `overdue`: those past
     * their due date today. The dashboard and billing report count the same.
     */
    balance: z.enum(['outstanding', 'overdue']).optional(),
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

/**
 * The default line for billing a case: its service and tax year. A case
 * invoice and a combined-invoice case line both start from it, with the case's
 * service fee as the unit amount.
 */
export function caseLineDescription(serviceName: string, taxYear: number): string {
  return `${serviceName} (tax year ${String(taxYear)})`.slice(0, INVOICE_LIMITS.descriptionMax);
}

/** One member's share of a combined invoice, in the order the client first appears. */
export interface InvoiceLineGroup<T> {
  readonly clientId: string;
  readonly items: readonly T[];
  readonly subtotalMinor: number;
}

/**
 * Groups a combined invoice's lines by the client each is for (TD-511), in
 * the order each client first appears, with a subtotal per client. Lines with
 * no client (individual invoices) are ignored.
 */
export function groupLinesByClient<
  T extends { readonly clientId: string | null; readonly lineTotalMinor: number },
>(items: readonly T[]): InvoiceLineGroup<T>[] {
  const groups = new Map<string, { items: T[]; subtotalMinor: number }>();
  for (const item of items) {
    if (item.clientId === null) continue;
    const group = groups.get(item.clientId) ?? { items: [], subtotalMinor: 0 };
    group.items.push(item);
    group.subtotalMinor += item.lineTotalMinor;
    groups.set(item.clientId, group);
  }
  return [...groups.entries()].map(([clientId, group]) => ({ clientId, ...group }));
}

export const BillableCasesQuerySchema = z
  .object({
    /** The line client: the combined invoice's group head or a current member. */
    clientId: UuidV7Schema,
  })
  .strict();

export type BillableCasesQuery = z.infer<typeof BillableCasesQuerySchema>;

/** Another invoice that already bills a case (the duplicate-billing warning). */
export const CaseInvoiceRefSchema = z
  .object({
    id: UuidSchema,
    invoiceNumber: z.string().regex(INVOICE_NUMBER_PATTERN).nullable(),
    status: InvoiceStatusSchema,
  })
  .strict();

export type CaseInvoiceRef = z.infer<typeof CaseInvoiceRefSchema>;

/**
 * A case that can go on a combined-invoice line (TD-511), with the default
 * line it starts from and the other invoices, not void, that already bill it.
 * Those invoices are a warning only: partial and follow-up billing are allowed.
 */
export const BillableCaseSchema = z
  .object({
    id: UuidSchema,
    caseCode: z.string(),
    serviceName: z.string(),
    taxYear: z.number().int(),
    description: z.string().min(1).max(INVOICE_LIMITS.descriptionMax),
    unitAmountMinor: MinorAmountSchema,
    otherInvoices: z.array(CaseInvoiceRefSchema),
  })
  .strict();

export type BillableCase = z.infer<typeof BillableCaseSchema>;

export const BillableCaseListSchema = z.object({ cases: z.array(BillableCaseSchema) }).strict();

export type BillableCaseList = z.infer<typeof BillableCaseListSchema>;

export const GroupBillingTotalsQuerySchema = z
  .object({
    /** The group head's client ID. */
    group: UuidV7Schema,
  })
  .strict();

export type GroupBillingTotalsQuery = z.infer<typeof GroupBillingTotalsQuerySchema>;

/**
 * Billing totals for a client group (TD-207): finalized invoices of the group
 * head and its visible members. Drafts and void invoices are not counted.
 * `invoicedMinor = paidMinor + outstandingMinor`.
 */
export const GroupBillingTotalsSchema = z
  .object({
    groupClientId: UuidV7Schema,
    currency: z.string().regex(/^[A-Z]{3}$/u),
    invoiceCount: z.number().int().min(0),
    invoicedMinor: MinorAmountSchema,
    paidMinor: MinorAmountSchema,
    outstandingMinor: MinorAmountSchema,
  })
  .strict();

export type GroupBillingTotals = z.infer<typeof GroupBillingTotalsSchema>;

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
    confirm: z.literal(true, { error: 'Confirm the void.' }),
  })
  .strict();

export type VoidInvoiceRequest = z.infer<typeof VoidInvoiceRequestSchema>;

export const PaymentReversalSchema = z
  .object({
    id: UuidSchema,
    amountMinor: MinorAmountSchema,
    reason: z.string().min(1).max(INVOICE_LIMITS.reasonMax),
    reversedByName: z.string().nullable(),
    reversedAt: z.iso.datetime(),
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
    recordedAt: z.iso.datetime(),
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

// ---------------------------------------------------------------------------
// Sharing an invoice (TD-513)
// ---------------------------------------------------------------------------

/**
 * How a share was completed: the device share sheet with the PDF attached, or
 * WhatsApp opened with the message (the PDF downloaded for staff to attach).
 */
export const InvoiceShareChannelSchema = z.enum(['share_sheet', 'whatsapp']);

export type InvoiceShareChannel = z.infer<typeof InvoiceShareChannelSchema>;

/** Phone digits WhatsApp accepts in a `wa.me` link: country code first, no `+`. */
export const WhatsAppPhoneSchema = z.string().regex(/^[1-9][0-9]{7,14}$/u);

/** What the browser needs to share one invoice. The server builds the message. */
export const InvoiceShareContextSchema = z
  .object({
    invoiceId: UuidSchema,
    invoiceNumber: z.string().min(1).max(32),
    fileName: z.string().min(1).max(255),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(1000),
    /** The client's contact phone, or `null` to let staff pick the chat. */
    whatsappPhone: WhatsAppPhoneSchema.nullable(),
  })
  .strict();

export type InvoiceShareContext = z.infer<typeof InvoiceShareContextSchema>;

export const InvoiceShareRequestSchema = z.object({ channel: InvoiceShareChannelSchema }).strict();

export type InvoiceShareRequest = z.infer<typeof InvoiceShareRequestSchema>;

const SHARE_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `2026-11-30` → `30 Nov 2026`, independent of the device's locale and timezone. */
export function formatShareDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  const name = SHARE_MONTHS[Number(month) - 1];
  return name === undefined || day === undefined
    ? isoDate
    : `${String(Number(day))} ${name} ${year ?? ''}`;
}

export interface InvoiceShareMessageInput {
  readonly firmName: string;
  readonly clientName: string;
  readonly invoiceNumber: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly outstandingMinor: number;
  readonly dueDate: string | null;
}

/**
 * The message sent with a shared invoice. It names the client by display name
 * only: no CNIC, NTN, or other identifier is ever an input.
 */
export function buildInvoiceShareMessage(input: InvoiceShareMessageInput): string {
  const amount = (minor: number): string => `${input.currency} ${formatMinorAmount(minor)}`;
  const outstanding =
    input.outstandingMinor === 0 ? `${amount(0)} (paid in full)` : amount(input.outstandingMinor);
  return [
    `Dear ${input.clientName},`,
    '',
    `Please find attached invoice ${input.invoiceNumber} from ${input.firmName}.`,
    `Total: ${amount(input.totalMinor)}`,
    `Outstanding: ${outstanding}`,
    ...(input.dueDate === null ? [] : [`Due date: ${formatShareDate(input.dueDate)}`]),
    '',
    `Thank you,`,
    input.firmName,
  ].join('\n');
}

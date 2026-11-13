import { formatMinorAmount } from '@taxdesk/shared';

/**
 * The text of a billing PDF as data. The renderer only draws this model, so
 * what a PDF says is unit-testable without parsing PDF bytes, and it is built
 * exclusively from finalized database rows.
 */
export interface PdfMetadata {
  readonly title: string;
  readonly subject: string;
  readonly keywords: readonly string[];
  readonly createdAt: string;
}

export interface PdfTextLine {
  readonly kind: 'heading' | 'text' | 'muted';
  readonly text: string;
}

export interface PdfTableRow {
  readonly cells: readonly string[];
  readonly emphasis?: boolean;
}

export interface PdfLayout {
  readonly metadata: PdfMetadata;
  /** Lines above the table, in order. */
  readonly header: readonly PdfTextLine[];
  readonly columns: readonly { readonly title: string; readonly align: 'left' | 'right' }[];
  readonly rows: readonly PdfTableRow[];
  /** Label/value pairs under the table, e.g. the totals. */
  readonly summary: readonly PdfTableRow[];
  readonly footer: readonly PdfTextLine[];
}

export interface InvoicePdfSnapshot {
  readonly firmName: string;
  readonly invoiceNumber: string;
  readonly currency: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly finalizedAt: string;
  readonly client: { readonly clientCode: string; readonly displayName: string };
  readonly caseCode: string | null;
  readonly items: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unitAmountMinor: number;
    readonly lineTotalMinor: number;
  }[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly notes: string;
}

export interface ReceiptPdfSnapshot {
  readonly firmName: string;
  readonly receiptNumber: string;
  readonly invoiceNumber: string;
  readonly currency: string;
  readonly recordedAt: string;
  readonly receivedOn: string;
  readonly method: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly invoiceTotalMinor: number;
  readonly client: { readonly clientCode: string; readonly displayName: string };
  readonly caseCode: string | null;
}

const METHOD_LABELS: Readonly<Record<string, string>> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

function money(currency: string, minor: number): string {
  return `${currency} ${formatMinorAmount(minor)}`;
}

export function buildInvoiceLayout(snapshot: InvoicePdfSnapshot): PdfLayout {
  const total = money(snapshot.currency, snapshot.totalMinor);
  return {
    metadata: {
      title: `Invoice ${snapshot.invoiceNumber}`,
      subject: `Invoice ${snapshot.invoiceNumber} for ${snapshot.client.clientCode}, total ${total}`,
      keywords: [
        snapshot.invoiceNumber,
        snapshot.client.clientCode,
        snapshot.currency,
        String(snapshot.totalMinor),
      ],
      createdAt: snapshot.finalizedAt,
    },
    header: [
      { kind: 'muted', text: snapshot.firmName },
      { kind: 'heading', text: 'INVOICE' },
      { kind: 'text', text: `Invoice number: ${snapshot.invoiceNumber}` },
      { kind: 'text', text: `Issue date: ${snapshot.issueDate}` },
      ...(snapshot.dueDate === null
        ? []
        : [{ kind: 'text', text: `Due date: ${snapshot.dueDate}` } as const]),
      {
        kind: 'text',
        text: `Billed to: ${snapshot.client.displayName} (${snapshot.client.clientCode})`,
      },
      ...(snapshot.caseCode === null
        ? []
        : [{ kind: 'text', text: `Case: ${snapshot.caseCode}` } as const]),
    ],
    columns: [
      { title: 'Description', align: 'left' },
      { title: 'Qty', align: 'right' },
      { title: `Unit (${snapshot.currency})`, align: 'right' },
      { title: `Amount (${snapshot.currency})`, align: 'right' },
    ],
    rows: snapshot.items.map((item) => ({
      cells: [
        item.description,
        String(item.quantity),
        formatMinorAmount(item.unitAmountMinor),
        formatMinorAmount(item.lineTotalMinor),
      ],
    })),
    summary: [
      { cells: ['Subtotal', money(snapshot.currency, snapshot.subtotalMinor)] },
      ...(snapshot.discountMinor === 0
        ? []
        : [{ cells: ['Discount', `- ${money(snapshot.currency, snapshot.discountMinor)}`] }]),
      { cells: ['Total', total], emphasis: true },
    ],
    footer:
      snapshot.notes.length === 0 ? [] : [{ kind: 'muted', text: `Notes: ${snapshot.notes}` }],
  };
}

export function buildReceiptLayout(snapshot: ReceiptPdfSnapshot): PdfLayout {
  const amount = money(snapshot.currency, snapshot.amountMinor);
  return {
    metadata: {
      title: `Receipt ${snapshot.receiptNumber}`,
      subject: `Receipt ${snapshot.receiptNumber} for invoice ${snapshot.invoiceNumber}, amount ${amount}`,
      keywords: [
        snapshot.receiptNumber,
        snapshot.invoiceNumber,
        snapshot.client.clientCode,
        snapshot.currency,
        String(snapshot.amountMinor),
      ],
      createdAt: snapshot.recordedAt,
    },
    header: [
      { kind: 'muted', text: snapshot.firmName },
      { kind: 'heading', text: 'PAYMENT RECEIPT' },
      { kind: 'text', text: `Receipt number: ${snapshot.receiptNumber}` },
      { kind: 'text', text: `Invoice: ${snapshot.invoiceNumber}` },
      { kind: 'text', text: `Received on: ${snapshot.receivedOn}` },
      {
        kind: 'text',
        text: `Received from: ${snapshot.client.displayName} (${snapshot.client.clientCode})`,
      },
      ...(snapshot.caseCode === null
        ? []
        : [{ kind: 'text', text: `Case: ${snapshot.caseCode}` } as const]),
    ],
    columns: [
      { title: 'Detail', align: 'left' },
      { title: 'Value', align: 'right' },
    ],
    rows: [
      { cells: ['Payment method', METHOD_LABELS[snapshot.method] ?? snapshot.method] },
      ...(snapshot.reference.length === 0 ? [] : [{ cells: ['Reference', snapshot.reference] }]),
      { cells: ['Invoice total', money(snapshot.currency, snapshot.invoiceTotalMinor)] },
    ],
    summary: [{ cells: ['Amount received', amount], emphasis: true }],
    footer: [
      {
        kind: 'muted',
        text: 'This receipt records one payment. Later corrections appear as separate entries.',
      },
    ],
  };
}

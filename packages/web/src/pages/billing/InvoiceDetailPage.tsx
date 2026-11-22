import { Fragment, useCallback, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Download, LoaderCircle, RotateCcw, Share2 } from 'lucide-react';
import { groupLinesByClient, type Invoice, type InvoiceItem, type Payment } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DocumentTitle } from '@/lib/document-title';
import { ApiError } from '../../api-client.js';
import {
  generateInvoicePdf,
  generateReceiptPdf,
  getInvoice,
  invoicePdfPath,
  listPayments,
  receiptPdfPath,
} from '../../billing-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS, casePath, clientPath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';
import {
  FinalizeInvoiceDialog,
  RecordPaymentDialog,
  ReversePaymentDialog,
  VoidInvoiceDialog,
} from './BillingDialogs.js';
import { InvoiceDraftEditor } from './InvoiceDraftEditor.js';
import { ShareInvoiceDialog } from './ShareInvoiceDialog.js';
import {
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_BADGE,
  PAYMENT_STATUS_LABELS,
  PDF_STATE_LABELS,
  formatDate,
  invoiceLineErrors,
  money,
} from './billing-format.js';

type Dialog = 'finalize' | 'payment' | 'void' | 'share' | null;

/** Why an invoice cannot be shared yet, or `null` when it can (TD-513). */
function shareBlocker(invoice: Invoice): string | null {
  if (invoice.status === 'draft') {
    return 'Drafts cannot be shared. Finalize the invoice to download or share it.';
  }
  if (invoice.status === 'void') {
    return 'Void invoices cannot be shared.';
  }
  if (invoice.pdfState !== 'ready') {
    return 'Share becomes available once the invoice PDF is stored.';
  }
  return null;
}

/** One invoice: the draft editor, or the frozen record with payments and PDFs. */
export function InvoiceDetailPage() {
  const headingId = useId();
  const { invoiceId = '' } = useParams();
  const { can } = useSession();
  const canManage = can('billing.manage');
  const canReverse = can('billing.payments.reverse');
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payments, setPayments] = useState<readonly Payment[]>([]);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<ReadonlyMap<string, string> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const loaded = await getInvoice(invoiceId, signal);
        const list =
          loaded.status === 'draft' ? { payments: [] } : await listPayments(invoiceId, signal);
        setInvoice(loaded);
        setPayments(list.payments);
        setNotice(null);
      } catch (error) {
        if (signal?.aborted !== true) {
          setNotice(toErrorNotice(error, 'Could not load the invoice'));
        }
      }
    },
    [invoiceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  /** The record changed under us: reload it and say so (never overwrite silently). */
  const refreshStale = useCallback(() => {
    setStale(true);
    setSuccess(null);
    void load();
  }, [load]);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 412) {
        refreshStale();
      } else {
        setNotice(toErrorNotice(error));
        setLineErrors(invoiceLineErrors(error));
      }
    },
    [refreshStale],
  );

  async function retryPdf(run: () => Promise<unknown>, label: string): Promise<void> {
    setWorking(label);
    setNotice(null);
    try {
      await run();
      setSuccess(`${label} is ready.`);
    } catch (error) {
      setNotice(toErrorNotice(error, `Could not store the ${label.toLowerCase()}`));
    } finally {
      setWorking(null);
      await load();
    }
  }

  if (invoice === null) {
    return (
      <section aria-labelledby={headingId}>
        <PageHeader id={headingId} title="Invoice" />
        {notice === null ? (
          <LoadingMessage>Loading invoice…</LoadingMessage>
        ) : (
          <ErrorAlert notice={notice} />
        )}
        <Link to={ROUTE_PATHS.invoices} className={buttonVariants({ variant: 'outline' })}>
          Back to invoices
        </Link>
      </section>
    );
  }

  const isDraft = invoice.status === 'draft';
  const isVoid = invoice.status === 'void';
  const title = invoice.invoiceNumber ?? 'Draft invoice';
  const pdfFailed = invoice.pdfState === 'failed' || invoice.pdfState === 'pending';
  const canVoid = canManage && !isVoid && invoice.paidMinor === 0;
  const combined = invoice.billingMode === 'combined';
  const notShareable = shareBlocker(invoice);
  const canShare = notShareable === null && invoice.invoiceNumber !== null;

  return (
    <section aria-labelledby={headingId}>
      <DocumentTitle title={title} />
      <PageHeader
        id={headingId}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {title}
            <Badge variant={INVOICE_STATUS_BADGE[invoice.status]}>
              {INVOICE_STATUS_LABELS[invoice.status]}
            </Badge>
            {!isDraft && !isVoid && (
              <Badge variant={PAYMENT_STATUS_BADGE[invoice.paymentStatus]}>
                {PAYMENT_STATUS_LABELS[invoice.paymentStatus]}
              </Badge>
            )}
            {combined && <Badge variant="outline">Combined</Badge>}
          </span>
        }
        description={
          <>
            <Link to={clientPath(invoice.client.id)} className="underline-offset-4 hover:underline">
              {invoice.client.displayName} ({invoice.client.clientCode})
            </Link>
            {combined && ' · combined invoice for the group'}
            {invoice.case !== null && (
              <>
                {' · '}
                <Link to={casePath(invoice.case.id)} className="underline-offset-4 hover:underline">
                  {invoice.case.caseCode}
                </Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {!isDraft && invoice.pdfState === 'ready' && (
              <a
                href={invoicePdfPath(invoice.id)}
                className={buttonVariants({ variant: 'outline' })}
              >
                <Download aria-hidden="true" />
                Download PDF
              </a>
            )}
            {canShare && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSuccess(null);
                  setDialog('share');
                }}
              >
                <Share2 aria-hidden="true" />
                Share
              </Button>
            )}
            {canManage && invoice.status === 'finalized' && invoice.outstandingMinor > 0 && (
              <Button
                type="button"
                onClick={() => {
                  setDialog('payment');
                }}
              >
                Record payment
              </Button>
            )}
            {canVoid && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialog('void');
                }}
              >
                Void invoice
              </Button>
            )}
          </>
        }
      />

      {notice !== null && <ErrorAlert notice={notice} />}
      {stale && (
        <InfoNotice tone="warning">
          This invoice changed while you were working. It has been refreshed: review the latest
          values and try again.
        </InfoNotice>
      )}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {isVoid && (
        <InfoNotice tone="warning">
          This invoice was voided
          {invoice.voidedAt === null ? '' : ` on ${formatDate(invoice.voidedAt.slice(0, 10))}`}
          {invoice.voidReason === null ? '' : `: ${invoice.voidReason}`}
        </InfoNotice>
      )}
      {isDraft && !canManage && (
        <InfoNotice>This invoice is a draft. Your role can view it but not change it.</InfoNotice>
      )}
      {isDraft && <p className="mb-4 text-sm text-muted-foreground">{notShareable}</p>}

      {isDraft && canManage ? (
        <InvoiceDraftEditor
          key={invoice.id}
          invoice={invoice}
          lineErrors={lineErrors}
          onSaved={(saved) => {
            setLineErrors(null);
            setInvoice(saved);
            setStale(false);
            setSuccess('Draft saved.');
          }}
          onStale={refreshStale}
          onFinalize={() => {
            setDialog('finalize');
          }}
        />
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Amounts</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                <Row label="Issue date" value={formatDate(invoice.issueDate)} />
                <Row label="Due date" value={formatDate(invoice.dueDate)} />
                <Row label="Subtotal" value={money(invoice.subtotalMinor)} />
                <Row label="Discount" value={money(invoice.discountMinor)} />
                <Row label="Total" value={money(invoice.totalMinor)} strong />
                <Row label="Paid" value={money(invoice.paidMinor)} />
                <Row label="Outstanding" value={money(invoice.outstandingMinor)} strong />
              </dl>
              {invoice.notes !== '' && (
                <p className="mt-4 text-sm text-muted-foreground">Notes: {invoice.notes}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Line items</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {combined
                    ? groupLinesByClient(
                        invoice.items.map((item) => ({
                          ...item,
                          clientId: item.client?.id ?? null,
                        })),
                      ).map((group) => {
                        const client = group.items[0]?.client;
                        return (
                          <Fragment key={group.clientId}>
                            <TableRow>
                              <TableHead scope="rowgroup" colSpan={4} className="bg-muted/50">
                                {client?.displayName}{' '}
                                <span className="font-mono text-xs font-normal text-muted-foreground">
                                  {client?.clientCode}
                                </span>
                              </TableHead>
                            </TableRow>
                            {group.items.map((item) => (
                              <LineRow key={item.id} item={item} />
                            ))}
                            <TableRow>
                              <TableCell colSpan={3} className="text-right text-muted-foreground">
                                Subtotal for {client?.displayName}
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {money(group.subtotalMinor)}
                              </TableCell>
                            </TableRow>
                          </Fragment>
                        );
                      })
                    : invoice.items.map((item) => <LineRow key={item.id} item={item} />)}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {!isDraft && (
        <div className="mt-5 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Invoice PDF</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3 text-sm">
              <span role="status">{PDF_STATE_LABELS[invoice.pdfState]}</span>
              {invoice.pdfState === 'failed' && (
                <span className="text-muted-foreground">
                  The invoice is saved. Document storage was unavailable, so the PDF was not stored.
                </span>
              )}
              {notShareable !== null && (
                <span className="text-muted-foreground">{notShareable}</span>
              )}
              {canManage && pdfFailed && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={working !== null}
                  onClick={() => {
                    void retryPdf(() => generateInvoicePdf(invoice.id), 'Invoice PDF');
                  }}
                >
                  {working === 'Invoice PDF' ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  ) : (
                    <RotateCcw aria-hidden="true" />
                  )}
                  Generate PDF again
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Payments and receipts</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {payments.length === 0 ? (
                <EmptyState title="No payments recorded">
                  Payments appear here with their receipts once recorded.
                </EmptyState>
              ) : (
                <ul className="divide-y">
                  {payments.map((payment) => {
                    const unreversed = payment.amountMinor - payment.reversedMinor;
                    return (
                      <li key={payment.id} className="space-y-2 py-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            <span className="font-mono font-medium">{payment.receiptNumber}</span>{' '}
                            {money(payment.amountMinor)} by {PAYMENT_METHOD_LABELS[payment.method]}{' '}
                            on {formatDate(payment.receivedOn)}
                            {payment.reference !== '' && ` (${payment.reference})`}
                          </span>
                          <span className="flex flex-wrap items-center gap-2">
                            {payment.receiptPdfState === 'ready' ? (
                              <a
                                href={receiptPdfPath(payment.id)}
                                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                aria-label={`Download receipt ${payment.receiptNumber}`}
                              >
                                <Download aria-hidden="true" />
                                Receipt
                              </a>
                            ) : (
                              canManage && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={working !== null}
                                  onClick={() => {
                                    void retryPdf(
                                      () => generateReceiptPdf(payment.id),
                                      `Receipt ${payment.receiptNumber}`,
                                    );
                                  }}
                                >
                                  Generate receipt {payment.receiptNumber} again
                                </Button>
                              )
                            )}
                            {canReverse && unreversed > 0 && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label={`Reverse payment ${payment.receiptNumber}`}
                                onClick={() => {
                                  setReversing(payment);
                                }}
                              >
                                Reverse
                              </Button>
                            )}
                          </span>
                        </div>
                        {payment.reversals.length > 0 && (
                          <ul className="ml-4 space-y-1 text-muted-foreground">
                            {payment.reversals.map((reversal) => (
                              <li key={reversal.id}>
                                Reversed {money(reversal.amountMinor)} on{' '}
                                {formatDate(reversal.reversedAt.slice(0, 10))}: {reversal.reason}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <FinalizeInvoiceDialog
        invoice={invoice}
        open={dialog === 'finalize'}
        onOpenChange={(open) => {
          setDialog(open ? 'finalize' : null);
        }}
        onError={handleError}
        onFinalized={(finalized) => {
          setDialog(null);
          setInvoice(finalized);
          setStale(false);
          setSuccess(`Invoice ${finalized.invoiceNumber ?? ''} finalized.`);
        }}
      />
      <RecordPaymentDialog
        invoice={invoice}
        open={dialog === 'payment'}
        onOpenChange={(open) => {
          setDialog(open ? 'payment' : null);
        }}
        onRecorded={(outcome) => {
          setDialog(null);
          setInvoice(outcome.invoice);
          setPayments((current) => [...current, outcome.payment]);
          setStale(false);
          setSuccess(`Payment recorded with receipt ${outcome.payment.receiptNumber}.`);
        }}
      />
      <ReversePaymentDialog
        payment={reversing}
        open={reversing !== null}
        onOpenChange={(open) => {
          if (!open) setReversing(null);
        }}
        onReversed={(outcome) => {
          setReversing(null);
          setInvoice(outcome.invoice);
          setPayments((current) =>
            current.map((entry) => (entry.id === outcome.payment.id ? outcome.payment : entry)),
          );
          setStale(false);
          setSuccess('Payment reversed. The balance was recalculated.');
        }}
      />
      {invoice.invoiceNumber !== null && (
        <ShareInvoiceDialog
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoiceNumber}
          open={dialog === 'share'}
          onOpenChange={(open) => {
            setDialog(open ? 'share' : null);
          }}
          onShared={(message) => {
            setNotice(null);
            setSuccess(message);
          }}
          onNotRecorded={(failure) => {
            setSuccess(null);
            setNotice(failure);
          }}
        />
      )}
      <VoidInvoiceDialog
        invoice={invoice}
        open={dialog === 'void'}
        onOpenChange={(open) => {
          setDialog(open ? 'void' : null);
        }}
        onError={handleError}
        onVoided={(voided) => {
          setDialog(null);
          setInvoice(voided);
          setStale(false);
          setSuccess('Invoice voided.');
        }}
      />
    </section>
  );
}

function LineRow({ item }: { item: InvoiceItem }) {
  return (
    <TableRow>
      <TableCell>
        {item.description}
        {item.case !== null && (
          <>
            {' '}
            <Link
              to={casePath(item.case.id)}
              className="font-mono text-xs text-primary underline-offset-4 hover:underline"
            >
              {item.case.caseCode}
            </Link>
          </>
        )}
      </TableCell>
      <TableCell className="text-right">{item.quantity}</TableCell>
      <TableCell className="text-right">{money(item.unitAmountMinor)}</TableCell>
      <TableCell className="text-right">{money(item.lineTotalMinor)}</TableCell>
    </TableRow>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? 'font-semibold' : undefined}>{value}</dd>
    </div>
  );
}

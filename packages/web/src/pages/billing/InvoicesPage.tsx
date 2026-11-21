import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import {
  INVOICE_STATUSES,
  PAYMENT_STATUSES,
  type GroupBillingTotals,
  type InvoiceStatus,
  type InvoiceSummary,
  type PaymentStatus,
} from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getGroupBillingTotals, listInvoices, type InvoiceFilters } from '../../billing-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { invoicePath } from '../../routes.js';
import { toErrorNotice } from '../error-notice.js';
import { GroupFilterField } from '../clients/GroupFilterField.js';
import {
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_LABELS,
  PAYMENT_STATUS_BADGE,
  PAYMENT_STATUS_LABELS,
  formatDate,
  money,
} from './billing-format.js';

const PAGE_SIZE = 25;

function readFilters(parameters: URLSearchParams): InvoiceFilters {
  const status = parameters.get('status');
  const paymentStatus = parameters.get('paymentStatus');
  const balance = parameters.get('balance');
  const group = parameters.get('group');
  return {
    ...(balance === 'outstanding' || balance === 'overdue' ? { balance } : {}),
    ...(group === null || group.length === 0 ? {} : { group }),
    ...(status !== null && (INVOICE_STATUSES as readonly string[]).includes(status)
      ? { status: status as InvoiceStatus }
      : {}),
    ...(paymentStatus !== null && (PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)
      ? { paymentStatus: paymentStatus as PaymentStatus }
      : {}),
  };
}

/**
 * Invoiced, paid, and outstanding totals for the selected group (TD-207):
 * finalized invoices of the group head and its visible members, calculated by
 * the server. Drafts and void invoices are not counted.
 */
function GroupTotals({ group }: { group: string }) {
  const [totals, setTotals] = useState<GroupBillingTotals | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setTotals(null);
    setFailed(false);
    void getGroupBillingTotals(group, controller.signal)
      .then(setTotals)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
    };
  }, [group]);

  if (failed) {
    return <InfoNotice tone="warning">Could not load the group&apos;s billing totals.</InfoNotice>;
  }
  if (totals === null) {
    return <LoadingMessage>Loading group totals…</LoadingMessage>;
  }
  const figures = [
    { label: 'Invoiced', value: totals.invoicedMinor },
    { label: 'Paid', value: totals.paidMinor },
    { label: 'Outstanding', value: totals.outstandingMinor },
  ];
  return (
    <section aria-label="Group billing totals" className="mb-4">
      <dl className="grid gap-3 sm:grid-cols-3">
        {figures.map((figure) => (
          <Card key={figure.label} className="gap-1 px-4 py-3">
            <dt className="text-sm text-muted-foreground">{figure.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{money(figure.value)}</dd>
          </Card>
        ))}
      </dl>
      <p className="mt-2 text-sm text-muted-foreground">
        {totals.invoiceCount} finalized {totals.invoiceCount === 1 ? 'invoice' : 'invoices'} for the
        group head and its members. Drafts and void invoices are not counted.
      </p>
    </section>
  );
}

/** All invoices, newest first, with URL-held filters and load-more paging. */
export function InvoicesPage() {
  const headingId = useId();
  const [parameters, setParameters] = useSearchParams();
  const filterKey = parameters.toString();
  const [invoices, setInvoices] = useState<readonly InvoiceSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setInvoices(null);
      setNotice(null);
      try {
        const list = await listInvoices(
          { ...readFilters(new URLSearchParams(filterKey)), limit: PAGE_SIZE },
          signal,
        );
        setInvoices(list.invoices);
        setCursor(list.nextCursor);
      } catch (error) {
        if (!signal.aborted) {
          setInvoices([]);
          setNotice(toErrorNotice(error, 'Could not load invoices'));
        }
      }
    },
    [filterKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  function setParameter(name: string, value: string): void {
    const next = new URLSearchParams(parameters);
    if (value.length === 0) next.delete(name);
    else next.set(name, value);
    setParameters(next);
  }

  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const list = await listInvoices({ ...readFilters(parameters), limit: PAGE_SIZE, cursor });
      setInvoices((current) => [...(current ?? []), ...list.invoices]);
      setCursor(list.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more invoices'));
    } finally {
      setLoadingMore(false);
    }
  }

  const filters = readFilters(parameters);
  const filtered = Object.keys(filters).length > 0;

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Invoices"
        description="Invoices and what is still owed. Open a client or case to create one."
      />
      {filters.balance !== undefined && (
        <InfoNotice>
          Showing:{' '}
          {filters.balance === 'overdue'
            ? 'overdue invoices with a balance'
            : 'invoices with a balance'}
          .{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              setParameter('balance', '');
            }}
          >
            Clear this filter
          </button>
        </InfoNotice>
      )}
      <div className="mb-4 flex flex-wrap gap-4">
        <Field className="w-48">
          <FieldLabel htmlFor={`${headingId}-status`}>Status</FieldLabel>
          <NativeSelect
            id={`${headingId}-status`}
            value={filters.status ?? ''}
            onChange={(event) => {
              setParameter('status', event.target.value);
            }}
          >
            <NativeSelectOption value="">Any status</NativeSelectOption>
            {INVOICE_STATUSES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {INVOICE_STATUS_LABELS[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="w-48">
          <FieldLabel htmlFor={`${headingId}-payment`}>Payment</FieldLabel>
          <NativeSelect
            id={`${headingId}-payment`}
            value={filters.paymentStatus ?? ''}
            onChange={(event) => {
              setParameter('paymentStatus', event.target.value);
            }}
          >
            <NativeSelectOption value="">Any payment state</NativeSelectOption>
            {PAYMENT_STATUSES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {PAYMENT_STATUS_LABELS[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div className="w-64">
          <GroupFilterField
            id={`${headingId}-group`}
            value={filters.group ?? ''}
            onChange={(value) => {
              setParameter('group', value);
            }}
          />
        </div>
      </div>

      {filters.group !== undefined && <GroupTotals group={filters.group} />}

      {notice !== null && <ErrorAlert notice={notice} />}
      {invoices === null ? (
        <LoadingMessage>Loading invoices…</LoadingMessage>
      ) : invoices.length === 0 && notice === null ? (
        <Card>
          <EmptyState title={filtered ? 'No invoices match these filters' : 'No invoices yet'}>
            {filtered
              ? 'Clear a filter to see more.'
              : 'Create an invoice from a client or a case page.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <Table>
            <TableCaption className="sr-only">Invoices, newest first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <Link
                      to={invoicePath(invoice.id)}
                      className="font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {invoice.invoiceNumber ?? 'Draft'}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {invoice.client.displayName}
                    <span className="block text-xs text-muted-foreground">
                      {invoice.client.clientCode}
                      {invoice.case !== null && ` · ${invoice.case.caseCode}`}
                      {invoice.billingMode === 'combined' && ' · combined for the group'}
                    </span>
                  </TableCell>
                  <TableCell>{formatDate(invoice.dueDate)}</TableCell>
                  <TableCell className="text-right">{money(invoice.totalMinor)}</TableCell>
                  <TableCell className="text-right">{money(invoice.outstandingMinor)}</TableCell>
                  <TableCell className="space-x-1">
                    <Badge variant={INVOICE_STATUS_BADGE[invoice.status]}>
                      {INVOICE_STATUS_LABELS[invoice.status]}
                    </Badge>
                    {invoice.status === 'finalized' && (
                      <Badge variant={PAYMENT_STATUS_BADGE[invoice.paymentStatus]}>
                        {PAYMENT_STATUS_LABELS[invoice.paymentStatus]}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {cursor !== null && (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

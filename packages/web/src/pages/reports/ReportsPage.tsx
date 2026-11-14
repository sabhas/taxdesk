import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Download, LoaderCircle } from 'lucide-react';
import {
  WORKFLOW_STATUS_KINDS,
  monthBounds,
  type BillingReport,
  type CaseListItem,
  type CasePerson,
  type ServiceType,
  type WorkloadReport,
} from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { cn } from '@/lib/utils';
import { ApiError } from '../../api-client.js';
import { listCaseAssignees, listServiceTypes } from '../../case-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  PermissionDenied,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import {
  billingReportCsvUrl,
  caseReportCsvUrl,
  getBillingReport,
  getCaseReport,
  getWorkloadReport,
  type CaseReportFilters,
} from '../../report-api.js';
import { ROUTE_PATHS, casePath, invoicePath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { INVOICE_STATUS_LABELS, PAYMENT_STATUS_LABELS, money } from '../billing/billing-format.js';
import { STATUS_KIND_BADGE, formatDate, urgencyLabel } from '../cases/case-format.js';
import { toErrorNotice } from '../error-notice.js';

export type ReportSection = 'cases' | 'workload' | 'billing';

const PAGE_SIZE = 25;

const SECTIONS: readonly { key: ReportSection; label: string; path: string }[] = [
  { key: 'cases', label: 'Cases', path: ROUTE_PATHS.reports },
  { key: 'workload', label: 'Staff workload', path: ROUTE_PATHS.reportsWorkload },
  { key: 'billing', label: 'Billing', path: ROUTE_PATHS.reportsBilling },
];

const STATUS_KIND_LABELS: Readonly<Record<string, string>> = {
  open: 'In progress',
  filed: 'Filed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** A 403 on a report is shown as "not allowed", not as a failure. */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

function useParam(parameters: URLSearchParams, setParameters: (next: URLSearchParams) => void) {
  return (name: string, value: string): void => {
    const next = new URLSearchParams(parameters);
    if (value.length === 0) next.delete(name);
    else next.set(name, value);
    setParameters(next);
  };
}

interface Lookups {
  readonly services: readonly ServiceType[];
  readonly people: readonly CasePerson[];
}

function useLookups(): Lookups {
  const [lookups, setLookups] = useState<Lookups>({ services: [], people: [] });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listServiceTypes('all', controller.signal),
      listCaseAssignees(controller.signal),
    ])
      .then(([serviceList, assignees]) => {
        setLookups({ services: serviceList.serviceTypes, people: assignees.assignees });
      })
      .catch(() => {
        // Filters fall back to "any"; the report itself still loads.
      });
    return () => {
      controller.abort();
    };
  }, []);
  return lookups;
}

function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

function ServiceField({
  id,
  value,
  services,
  onChange,
}: {
  id: string;
  value: string;
  services: readonly ServiceType[];
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Service</FieldLabel>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <NativeSelectOption value="">Any service</NativeSelectOption>
        {services.map((service) => (
          <NativeSelectOption key={service.id} value={service.id}>
            {service.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

function TaxYearField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Tax year</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        placeholder="e.g. 2025"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

function LoadMore({
  cursor,
  loading,
  onClick,
}: {
  cursor: string | null;
  loading: boolean;
  onClick: () => void;
}) {
  if (cursor === null) return null;
  return (
    <div className="flex justify-center border-t p-3">
      <Button
        type="button"
        variant="outline"
        disabled={loading}
        aria-busy={loading}
        onClick={onClick}
      >
        {loading && <LoaderCircle aria-hidden="true" className="animate-spin" />}
        {loading ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Case report (TD-602)
// ---------------------------------------------------------------------------

const CASE_FILTER_KEYS = [
  'from',
  'to',
  'service',
  'statusKind',
  'assignee',
  'taxYear',
  'state',
] as const;

function CaseReportView({ canExport }: { canExport: boolean }) {
  const id = useId();
  const [parameters, setParameters] = useSearchParams();
  const setParam = useParam(parameters, setParameters);
  const lookups = useLookups();
  const key = CASE_FILTER_KEYS.map((name) => `${name}=${parameters.get(name) ?? ''}`).join('&');
  const [cases, setCases] = useState<readonly CaseListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [denied, setDenied] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const filters = (): CaseReportFilters => {
    const result: Record<string, string> = {};
    for (const name of CASE_FILTER_KEYS) {
      const value = parameters.get(name);
      if (value !== null && value.length > 0) result[name] = value;
    }
    return result;
  };

  const load = useCallback(
    async (signal: AbortSignal) => {
      setCases(null);
      setNotice(null);
      const current: Record<string, string> = {};
      for (const [name, value] of new URLSearchParams(key)) {
        if (value.length > 0) current[name] = value;
      }
      try {
        const report = await getCaseReport({ ...current, limit: PAGE_SIZE }, signal);
        setCases(report.cases);
        setTotal(report.total);
        setCursor(report.nextCursor);
      } catch (error) {
        if (signal.aborted) return;
        setCases([]);
        if (isForbidden(error)) setDenied(true);
        else setNotice(toErrorNotice(error, 'Could not load the case report'));
      }
    },
    [key],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  async function loadMore(): Promise<void> {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const report = await getCaseReport({ ...filters(), limit: PAGE_SIZE, cursor });
      setCases((current) => [...(current ?? []), ...report.cases]);
      setCursor(report.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more cases'));
    } finally {
      setLoadingMore(false);
    }
  }

  if (denied) return <ReportDenied what="case reports" />;
  const active = filters();
  const filtered =
    Object.keys(active).some((name) => name !== 'state') || active.state !== undefined;

  return (
    <>
      <form
        role="search"
        aria-label="Filter the case report"
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <DateField
          id={`${id}-from`}
          label="Due from"
          value={parameters.get('from') ?? ''}
          onChange={(v) => {
            setParam('from', v);
          }}
        />
        <DateField
          id={`${id}-to`}
          label="Due to"
          value={parameters.get('to') ?? ''}
          onChange={(v) => {
            setParam('to', v);
          }}
        />
        <ServiceField
          id={`${id}-service`}
          value={parameters.get('service') ?? ''}
          services={lookups.services}
          onChange={(v) => {
            setParam('service', v);
          }}
        />
        <Field>
          <FieldLabel htmlFor={`${id}-kind`}>Status</FieldLabel>
          <NativeSelect
            id={`${id}-kind`}
            className="w-full"
            value={parameters.get('statusKind') ?? ''}
            onChange={(event) => {
              setParam('statusKind', event.target.value);
            }}
          >
            <NativeSelectOption value="">Any status</NativeSelectOption>
            {WORKFLOW_STATUS_KINDS.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {STATUS_KIND_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-assignee`}>Staff member</FieldLabel>
          <NativeSelect
            id={`${id}-assignee`}
            className="w-full"
            value={parameters.get('assignee') ?? ''}
            onChange={(event) => {
              setParam('assignee', event.target.value);
            }}
          >
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {lookups.people.map((person) => (
              <NativeSelectOption key={person.id} value={person.id}>
                {person.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <TaxYearField
          id={`${id}-year`}
          value={parameters.get('taxYear') ?? ''}
          onChange={(v) => {
            setParam('taxYear', v);
          }}
        />
        <Field>
          <FieldLabel htmlFor={`${id}-state`}>Active or archived</FieldLabel>
          <NativeSelect
            id={`${id}-state`}
            className="w-full"
            value={parameters.get('state') ?? 'active'}
            onChange={(event) => {
              setParam('state', event.target.value === 'active' ? '' : event.target.value);
            }}
          >
            <NativeSelectOption value="active">Active cases</NativeSelectOption>
            <NativeSelectOption value="archived">Archived cases</NativeSelectOption>
            <NativeSelectOption value="all">Active and archived</NativeSelectOption>
          </NativeSelect>
        </Field>
        {canExport && (
          <a
            href={caseReportCsvUrl(filters())}
            download
            className={cn(buttonVariants({ variant: 'outline' }), 'lg:justify-self-start')}
          >
            <Download aria-hidden="true" />
            Export CSV
          </a>
        )}
      </form>
      {notice !== null && <ErrorAlert notice={notice} />}
      {cases === null ? (
        <LoadingMessage>Loading the case report…</LoadingMessage>
      ) : cases.length === 0 && notice === null ? (
        <Card>
          <EmptyState title={filtered ? 'No cases match these filters' : 'No cases yet'}>
            {filtered ? 'Widen the dates or clear a filter.' : 'Cases you can see appear here.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <p className="border-b px-4 py-2 text-sm text-muted-foreground" role="status">
            {total} {total === 1 ? 'case' : 'cases'} match
          </p>
          <Table>
            <TableCaption className="sr-only">Case report, ordered by due date</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Case</TableHead>
                <TableHead scope="col">Client</TableHead>
                <TableHead scope="col">Service</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Due</TableHead>
                <TableHead scope="col">Consultant</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      to={casePath(item.id)}
                      className="font-medium underline underline-offset-2"
                    >
                      {item.caseCode}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      Tax year {item.taxYear}
                    </span>
                  </TableCell>
                  <TableCell>{item.client.displayName}</TableCell>
                  <TableCell>{item.serviceName}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_KIND_BADGE[item.status.kind]}>{item.status.name}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(item.dueDate)}
                    {item.urgency !== null && (
                      <span className="block text-xs text-muted-foreground">
                        {urgencyLabel(item.urgency)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{item.primaryConsultant?.displayName ?? 'Unassigned'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <LoadMore cursor={cursor} loading={loadingMore} onClick={() => void loadMore()} />
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff workload (TD-602)
// ---------------------------------------------------------------------------

function WorkloadView() {
  const id = useId();
  const [parameters, setParameters] = useSearchParams();
  const setParam = useParam(parameters, setParameters);
  const lookups = useLookups();
  const key = parameters.toString();
  const [report, setReport] = useState<WorkloadReport | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setNotice(null);
    const filters: Record<string, string> = {};
    for (const name of ['from', 'to', 'service', 'taxYear']) {
      const value = new URLSearchParams(key).get(name);
      if (value !== null && value.length > 0) filters[name] = value;
    }
    void getWorkloadReport(filters, controller.signal)
      .then(setReport)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isForbidden(error)) setDenied(true);
        else setNotice(toErrorNotice(error, 'Could not load the workload report'));
      });
    return () => {
      controller.abort();
    };
  }, [key]);

  if (denied) return <ReportDenied what="workload reports" />;

  return (
    <>
      <form
        role="search"
        aria-label="Filter the workload report"
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <DateField
          id={`${id}-from`}
          label="Due from"
          value={parameters.get('from') ?? ''}
          onChange={(v) => {
            setParam('from', v);
          }}
        />
        <DateField
          id={`${id}-to`}
          label="Due to"
          value={parameters.get('to') ?? ''}
          onChange={(v) => {
            setParam('to', v);
          }}
        />
        <ServiceField
          id={`${id}-service`}
          value={parameters.get('service') ?? ''}
          services={lookups.services}
          onChange={(v) => {
            setParam('service', v);
          }}
        />
        <TaxYearField
          id={`${id}-year`}
          value={parameters.get('taxYear') ?? ''}
          onChange={(v) => {
            setParam('taxYear', v);
          }}
        />
      </form>
      {notice !== null && <ErrorAlert notice={notice} />}
      {report === null ? (
        notice === null && <LoadingMessage>Loading the workload report…</LoadingMessage>
      ) : report.rows.length === 0 ? (
        <Card>
          <EmptyState title="No staff can hold case work yet">
            Invite consultants or managers from the Users page.
          </EmptyState>
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <Table>
            <TableCaption className="sr-only">
              Open cases per staff member. Due soon means due within {report.dueSoonDays} days.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Staff member</TableHead>
                <TableHead scope="col" className="text-right">
                  Open
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Overdue
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Due soon
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Reviewing
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((row) => (
                <TableRow key={row.userId ?? 'none'}>
                  <TableCell className="font-medium">{row.displayName}</TableCell>
                  {[row.open, row.overdue, row.dueSoon, row.reviewing].map((entry, index) => (
                    <TableCell key={index} className="text-right tabular-nums">
                      <Link to={entry.href} className="underline underline-offset-2">
                        {entry.count}
                        <span className="sr-only"> cases for {row.displayName}</span>
                      </Link>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Billing report (TD-603)
// ---------------------------------------------------------------------------

function TotalTile({
  label,
  count,
  amount,
  tone,
}: {
  label: string;
  count: number;
  amount: number;
  tone?: 'warning';
}) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'warning' && count > 0 && 'text-destructive',
        )}
      >
        {money(amount)}
      </p>
      <p className="text-xs text-muted-foreground">
        {count} {count === 1 ? 'item' : 'items'}
      </p>
    </li>
  );
}

function BillingView({ canExport }: { canExport: boolean }) {
  const id = useId();
  const [parameters, setParameters] = useSearchParams();
  const setParam = useParam(parameters, setParameters);
  const bounds = monthBounds(today());
  const from = parameters.get('from') ?? bounds.start;
  const to = parameters.get('to') ?? bounds.end;
  const [report, setReport] = useState<BillingReport | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [denied, setDenied] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setNotice(null);
    if (to < from) {
      setNotice({
        title: 'Check the dates',
        message: 'The end date must be on or after the start date.',
      });
      return;
    }
    void getBillingReport({ from, to, limit: PAGE_SIZE }, controller.signal)
      .then((result) => {
        setReport(result);
        setCursor(result.nextCursor);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isForbidden(error)) setDenied(true);
        else setNotice(toErrorNotice(error, 'Could not load the billing report'));
      });
    return () => {
      controller.abort();
    };
  }, [from, to]);

  async function loadMore(): Promise<void> {
    if (cursor === null || report === null) return;
    setLoadingMore(true);
    try {
      const next = await getBillingReport({ from, to, limit: PAGE_SIZE, cursor });
      setReport({ ...report, invoices: [...report.invoices, ...next.invoices] });
      setCursor(next.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more invoices'));
    } finally {
      setLoadingMore(false);
    }
  }

  if (denied) return <ReportDenied what="billing reports" />;

  return (
    <>
      <form
        role="search"
        aria-label="Filter the billing report"
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <DateField
          id={`${id}-from`}
          label="From"
          value={from}
          onChange={(v) => {
            setParam('from', v);
          }}
        />
        <DateField
          id={`${id}-to`}
          label="To"
          value={to}
          onChange={(v) => {
            setParam('to', v);
          }}
        />
        {canExport && (
          <a
            href={billingReportCsvUrl({ from, to })}
            download
            className={cn(buttonVariants({ variant: 'outline' }), 'lg:justify-self-start')}
          >
            <Download aria-hidden="true" />
            Export CSV
          </a>
        )}
      </form>
      {notice !== null && <ErrorAlert notice={notice} />}
      {report === null ? (
        notice === null && <LoadingMessage>Loading the billing report…</LoadingMessage>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            Invoices issued, and payments received, from {formatDate(report.from)} to{' '}
            {formatDate(report.to)}. Balances are as of {formatDate(report.today)} and use the same
            calculation as each invoice.
          </p>
          <ul aria-label="Billing totals" className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TotalTile
              label="Invoiced"
              count={report.totals.invoiced.count}
              amount={report.totals.invoiced.amountMinor}
            />
            <TotalTile
              label="Payments received"
              count={report.totals.collected.count}
              amount={report.totals.collected.amountMinor}
            />
            <TotalTile
              label="Reversed"
              count={report.totals.reversed.count}
              amount={report.totals.reversed.amountMinor}
            />
            <TotalTile
              label="Net collected"
              count={report.totals.collected.count + report.totals.reversed.count}
              amount={report.totals.netCollectedMinor}
            />
            <TotalTile
              label="Outstanding"
              count={report.totals.outstanding.count}
              amount={report.totals.outstanding.amountMinor}
            />
            <TotalTile
              label="Overdue"
              count={report.totals.overdue.count}
              amount={report.totals.overdue.amountMinor}
              tone="warning"
            />
          </ul>
          {report.invoices.length === 0 ? (
            <Card>
              <EmptyState title="No invoices were issued in this period">
                Choose a different date range.
              </EmptyState>
            </Card>
          ) : (
            <Card className="gap-0 py-0">
              <Table>
                <TableCaption className="sr-only">Invoices issued in the period</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Invoice</TableHead>
                    <TableHead scope="col">Client</TableHead>
                    <TableHead scope="col">Due</TableHead>
                    <TableHead scope="col" className="text-right">
                      Total
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Paid
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Outstanding
                    </TableHead>
                    <TableHead scope="col">Payment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        <Link
                          to={invoicePath(invoice.id)}
                          className="font-medium underline underline-offset-2"
                        >
                          {invoice.invoiceNumber ?? INVOICE_STATUS_LABELS[invoice.status]}
                        </Link>
                      </TableCell>
                      <TableCell>{invoice.client.displayName}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(invoice.dueDate ?? '')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(invoice.totalMinor)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(invoice.paidMinor)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(invoice.outstandingMinor)}
                      </TableCell>
                      <TableCell>{PAYMENT_STATUS_LABELS[invoice.paymentStatus]}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <LoadMore cursor={cursor} loading={loadingMore} onClick={() => void loadMore()} />
            </Card>
          )}
        </>
      )}
    </>
  );
}

function ReportDenied({ what }: { what: string }) {
  return (
    <InfoNotice tone="warning">
      Your role cannot view {what}. Ask an administrator if you need access.
    </InfoNotice>
  );
}

/**
 * Operational reports (TD-602, TD-603). Every figure is computed on the server
 * from your permissions; the CSV export is offered only to roles that hold the
 * report permission.
 */
export function ReportsPage({ section }: { section: ReportSection }) {
  const headingId = useId();
  const { can } = useSession();
  if (!can('reports.read')) {
    return <PermissionDenied />;
  }
  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Reports"
        description="Filter and export case, workload, and billing figures. Dates follow the firm calendar."
      />
      <nav aria-label="Reports" className="mb-4 overflow-x-auto">
        <ul className="flex gap-1 border-b">
          {SECTIONS.map((entry) => (
            <li key={entry.key}>
              <Link
                to={entry.path}
                aria-current={entry.key === section ? 'page' : undefined}
                className={cn(
                  '-mb-px flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  entry.key === section
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {section === 'cases' && <CaseReportView canExport />}
      {section === 'workload' && <WorkloadView />}
      {section === 'billing' && <BillingView canExport />}
    </section>
  );
}

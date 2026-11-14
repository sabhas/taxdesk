import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LoaderCircle, Plus } from 'lucide-react';
import {
  CASE_VIEWS,
  type CaseListItem,
  type CasePerson,
  type CaseQueueCounts,
  type CaseView,
  type ServiceType,
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
import {
  getQueueCounts,
  listCaseAssignees,
  listCases,
  listServiceTypes,
  type CaseFilters,
} from '../../case-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS, casePath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';
import { STATUS_KIND_BADGE, formatDate, urgencyLabel } from './case-format.js';

const PAGE_SIZE = 25;

const VIEW_LABELS: Readonly<Record<CaseView, string>> = {
  my: 'My work',
  team: 'Team',
  unassigned: 'Unassigned',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  closed: 'Closed',
  archived: 'Archived',
};

const FILTER_KEYS = [
  'service',
  'status',
  'assignee',
  'reviewer',
  'taxYear',
  'statusKind',
  'checklist',
] as const;

/** Drill-down conditions from the dashboard, described in words. */
const DRILL_DOWN_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  statusKind: {
    open: 'In progress (not yet filed)',
    filed: 'Filed',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },
  checklist: {
    gaps: 'Required checklist items outstanding',
    awaiting_review: 'Checklist items awaiting review',
  },
};

function readView(parameters: URLSearchParams, fallback: CaseView): CaseView {
  const view = parameters.get('view');
  return (CASE_VIEWS as readonly string[]).includes(view ?? '') ? (view as CaseView) : fallback;
}

function readFilters(parameters: URLSearchParams): CaseFilters {
  const filters: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = parameters.get(key);
    if (value !== null && value.length > 0) filters[key] = value;
  }
  return filters;
}

/**
 * Work queues (TD-308). The view, filters, and counts come from one server
 * query, so the number on a tab always matches the list behind it. State lives
 * in the URL so a queue can be bookmarked.
 */
export function CasesPage() {
  const headingId = useId();
  const { can } = useSession();
  const [parameters, setParameters] = useSearchParams();
  const defaultView: CaseView = can('cases.read_all') ? 'team' : 'my';
  const view = readView(parameters, defaultView);
  const filterKey = FILTER_KEYS.map((key) => `${key}=${parameters.get(key) ?? ''}`).join('&');
  const [cases, setCases] = useState<readonly CaseListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<CaseQueueCounts | null>(null);
  const [services, setServices] = useState<readonly ServiceType[]>([]);
  const [people, setPeople] = useState<readonly CasePerson[]>([]);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listServiceTypes('all', controller.signal),
      listCaseAssignees(controller.signal),
    ])
      .then(([serviceList, assignees]) => {
        setServices(serviceList.serviceTypes);
        setPeople(assignees.assignees);
      })
      .catch(() => {
        // Filters fall back to "any"; the queue itself still loads.
      });
    return () => {
      controller.abort();
    };
  }, []);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setCases(null);
      setNotice(null);
      const filters = readFilters(new URLSearchParams(filterKey));
      try {
        const [list, queueCounts] = await Promise.all([
          listCases({ ...filters, view, limit: PAGE_SIZE }, signal),
          getQueueCounts(filters, signal),
        ]);
        setCases(list.cases);
        setTotal(list.total);
        setCursor(list.nextCursor);
        setCounts(queueCounts);
      } catch (error) {
        if (!signal.aborted) {
          setCases([]);
          setNotice(toErrorNotice(error, 'Could not load cases'));
        }
      }
    },
    [filterKey, view],
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
      const list = await listCases({ ...readFilters(parameters), view, limit: PAGE_SIZE, cursor });
      setCases((current) => [...(current ?? []), ...list.cases]);
      setCursor(list.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more cases'));
    } finally {
      setLoadingMore(false);
    }
  }

  const filters = readFilters(parameters);
  const filtered = Object.keys(filters).length > 0;
  const canOpen = can('cases.manage') || can('cases.work_assigned');

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Cases"
        description="Work queues by assignment and urgency. Due dates use the firm calendar."
        actions={
          canOpen ? (
            <Link to={ROUTE_PATHS.newCase} className={buttonVariants()}>
              <Plus aria-hidden="true" />
              New case
            </Link>
          ) : undefined
        }
      />
      {(['statusKind', 'checklist'] as const).map((key) => {
        const value = filters[key];
        const label = value === undefined ? undefined : DRILL_DOWN_LABELS[key]?.[value];
        return label === undefined ? null : (
          <InfoNotice key={key}>
            Showing: {label}.{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setParameter(key, '');
              }}
            >
              Clear this filter
            </button>
          </InfoNotice>
        );
      })}
      {!can('cases.read_all') && (
        <InfoNotice>You see cases where you are the primary consultant or reviewer.</InfoNotice>
      )}

      <nav aria-label="Case queues" className="mb-4 overflow-x-auto">
        <ul className="flex gap-1 border-b">
          {CASE_VIEWS.map((key) => {
            const count =
              counts === null || !(key in counts) ? null : counts[key as keyof CaseQueueCounts];
            const active = key === view;
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    setParameter('view', key === defaultView ? '' : key);
                  }}
                  className={cn(
                    '-mb-px flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    active
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {VIEW_LABELS[key]}
                  {count !== null && (
                    <Badge
                      variant={key === 'overdue' && count > 0 ? 'destructive' : 'secondary'}
                      aria-label={`${String(count)} cases`}
                    >
                      {count}
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <form
        role="search"
        aria-label="Filter cases"
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${headingId}-service`}>Service</FieldLabel>
          <NativeSelect
            id={`${headingId}-service`}
            className="w-full"
            value={filters.service ?? ''}
            onChange={(event) => {
              setParameter('service', event.target.value);
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
        <Field>
          <FieldLabel htmlFor={`${headingId}-status`}>Status key</FieldLabel>
          <Input
            id={`${headingId}-status`}
            placeholder="e.g. in_review"
            defaultValue={filters.status ?? ''}
            key={`status-${filters.status ?? ''}`}
            onBlur={(event) => {
              setParameter('status', event.target.value.trim());
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                setParameter('status', event.currentTarget.value.trim());
              }
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${headingId}-assignee`}>Primary consultant</FieldLabel>
          <NativeSelect
            id={`${headingId}-assignee`}
            className="w-full"
            value={filters.assignee ?? ''}
            onChange={(event) => {
              setParameter('assignee', event.target.value);
            }}
          >
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {people.map((person) => (
              <NativeSelectOption key={person.id} value={person.id}>
                {person.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${headingId}-reviewer`}>Reviewer</FieldLabel>
          <NativeSelect
            id={`${headingId}-reviewer`}
            className="w-full"
            value={filters.reviewer ?? ''}
            onChange={(event) => {
              setParameter('reviewer', event.target.value);
            }}
          >
            <NativeSelectOption value="">Anyone</NativeSelectOption>
            {people.map((person) => (
              <NativeSelectOption key={person.id} value={person.id}>
                {person.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${headingId}-year`}>Tax year</FieldLabel>
          <Input
            id={`${headingId}-year`}
            inputMode="numeric"
            maxLength={4}
            defaultValue={filters.taxYear ?? ''}
            key={`year-${filters.taxYear ?? ''}`}
            onBlur={(event) => {
              const value = event.target.value.trim();
              setParameter('taxYear', /^\d{4}$/u.test(value) ? value : '');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const value = event.currentTarget.value.trim();
                setParameter('taxYear', /^\d{4}$/u.test(value) ? value : '');
              }
            }}
          />
        </Field>
      </form>

      {notice !== null && <ErrorAlert notice={notice} />}

      {cases === null ? (
        <LoadingMessage>Loading cases…</LoadingMessage>
      ) : (
        <Card className="py-0">
          {cases.length === 0 ? (
            <EmptyState
              title={filtered ? 'No cases match these filters' : `Nothing in ${VIEW_LABELS[view]}`}
            >
              {filtered ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => {
                    setParameters(
                      view === defaultView ? new URLSearchParams() : new URLSearchParams({ view }),
                    );
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined}
            </EmptyState>
          ) : (
            <Table>
              <TableCaption className="sr-only">
                {`${VIEW_LABELS[view]}: ${String(total)} cases, ${String(cases.length)} shown.`}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Case</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Consultant</TableHead>
                  <TableHead>Reviewer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((item) => {
                  const urgency = urgencyLabel(item.urgency);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Link
                          to={casePath(item.id)}
                          className="font-mono font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {item.caseCode}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div>{item.client.displayName}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {item.client.clientCode}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{item.serviceName}</div>
                        <div className="text-xs text-muted-foreground">Tax year {item.taxYear}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_KIND_BADGE[item.status.kind]}>
                          {item.status.name}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <time dateTime={item.dueDate}>{formatDate(item.dueDate)}</time>
                        {urgency !== null && (
                          <Badge
                            variant={item.urgency === 'overdue' ? 'destructive' : 'warning'}
                            className="ml-2"
                          >
                            {urgency}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{item.primaryConsultant?.displayName ?? 'Unassigned'}</TableCell>
                      <TableCell>{item.reviewer?.displayName ?? '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
      {cases !== null && cases.length > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <p role="status">
            Showing {cases.length} of {total}
          </p>
          {cursor !== null && (
            <Button
              type="button"
              variant="outline"
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {loadingMore ? 'Loading…' : 'Load more cases'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

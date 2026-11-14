import { useCallback, useEffect, useId, useState, type SubmitEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { AuditExplorerEvent } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  type ErrorNotice,
} from '../components/feedback.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { listAuditEvents, type AuditFilters } from '../report-api.js';
import { useSession } from '../session/session-context.js';
import { toErrorNotice } from './error-notice.js';

const PAGE_SIZE = 25;

const EMPTY_FORM = {
  from: '',
  to: '',
  action: '',
  entityType: '',
  entityId: '',
  requestId: '',
  actor: '',
};

type FormState = typeof EMPTY_FORM;

function toFilters(form: FormState): AuditFilters {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (value.trim().length > 0) {
      filters[key] = value.trim();
    }
  }
  return filters;
}

function Changes({ metadata }: { metadata: AuditExplorerEvent['metadata'] }) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <dl className="grid gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-mono text-muted-foreground">{key}</dt>
          <dd className="break-all">{value === null ? '—' : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Audit explorer (TD-604). Administrators filter by actor, date range, action,
 * entity, and request ID. Changes are masked by the server; only correlation
 * data (request ID, actor, entity) is shown.
 */
export function AuditPage() {
  const formId = useId();
  const { can } = useSession();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [applied, setApplied] = useState<AuditFilters>({});
  const [events, setEvents] = useState<readonly AuditExplorerEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  const load = useCallback(async (filters: AuditFilters, signal?: AbortSignal) => {
    setEvents(null);
    setNotice(null);
    try {
      const result = await listAuditEvents({ ...filters, limit: PAGE_SIZE }, signal);
      setEvents(result.events);
      setCursor(result.nextCursor);
    } catch (error) {
      if (signal?.aborted !== true) {
        setEvents([]);
        setNotice(toErrorNotice(error, 'Could not load audit history'));
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(applied, controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, applied]);

  if (!can('audit.read')) {
    return <PermissionDenied />;
  }

  function search(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    setApplied(toFilters(form));
  }

  function reset(): void {
    setForm(EMPTY_FORM);
    setApplied({});
  }

  async function loadMore(): Promise<void> {
    if (cursor === null) {
      return;
    }
    setLoadingMore(true);
    setNotice(null);
    try {
      const result = await listAuditEvents({ ...applied, limit: PAGE_SIZE, cursor });
      setEvents((current) => [...(current ?? []), ...result.events]);
      setCursor(result.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more audit history'));
    } finally {
      setLoadingMore(false);
    }
  }

  const bind = (name: keyof FormState) => ({
    id: `${formId}-${name}`,
    value: form[name],
    onChange: (event: { target: { value: string } }) => {
      setForm((current) => ({ ...current, [name]: event.target.value }));
    },
  });
  const filtered = Object.keys(applied).length > 0;

  return (
    <section aria-labelledby="audit-heading">
      <PageHeader
        id="audit-heading"
        title="Audit history"
        description="Audit events are append-only. Secrets, tokens, and national identifiers are masked; request IDs let you trace one action across systems."
      />
      <form
        role="search"
        aria-label="Filter audit history"
        onSubmit={search}
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <Field>
          <FieldLabel htmlFor={`${formId}-from`}>From date</FieldLabel>
          <Input type="date" {...bind('from')} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-to`}>To date</FieldLabel>
          <Input type="date" {...bind('to')} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-action`}>Action</FieldLabel>
          <Input placeholder="billing.* or client.created" maxLength={120} {...bind('action')} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-actor`}>Actor user ID</FieldLabel>
          <Input maxLength={36} {...bind('actor')} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-entityType`}>Entity type</FieldLabel>
          <Input placeholder="invoice" maxLength={80} {...bind('entityType')} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-entityId`}>Entity ID</FieldLabel>
          <Input maxLength={36} {...bind('entityId')} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-requestId`}>Request ID</FieldLabel>
          <Input maxLength={128} {...bind('requestId')} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit">Search</Button>
          <Button type="button" variant="outline" onClick={reset}>
            Clear
          </Button>
        </div>
      </form>
      {notice !== null && <ErrorAlert notice={notice} />}
      {events === null ? (
        notice === null && <LoadingMessage>Loading audit history…</LoadingMessage>
      ) : (
        <Card className="gap-0 py-0">
          {events.length === 0 ? (
            <EmptyState title={filtered ? 'No audit events match' : 'No audit events yet'}>
              {filtered
                ? 'Widen the dates or clear a filter.'
                : 'Sign-ins, user changes and setting changes will appear here.'}
            </EmptyState>
          ) : (
            <Table>
              <TableCaption className="sr-only">Audit events, most recent first</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col">Actor</TableHead>
                  <TableHead scope="col">Action</TableHead>
                  <TableHead scope="col">Entity</TableHead>
                  <TableHead scope="col">Changes</TableHead>
                  <TableHead scope="col">Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(event.occurredAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{event.actorDisplayName ?? 'System'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono font-normal">
                        {event.action}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {event.entityType}
                      {event.entityId !== null && (
                        <span className="block font-mono text-xs text-muted-foreground">
                          {event.entityId}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <Changes metadata={event.metadata} />
                    </TableCell>
                    <TableCell>
                      <code className="text-xs break-all text-muted-foreground">
                        {event.requestId}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {cursor !== null && (
            <div className="flex justify-center border-t p-3">
              <Button
                type="button"
                variant="outline"
                disabled={loadingMore}
                aria-busy={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </section>
  );
}

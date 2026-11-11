import { useCallback, useEffect, useState, type SubmitEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LoaderCircle, Plus, Search } from 'lucide-react';
import type { ClientAssignee, ClientListItem, ClientType } from '@taxdesk/shared';
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
import { listClientAssignees, listClients, type ClientListParameters } from '../../client-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS, clientPath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';
import { CLIENT_TYPE_LABELS, contactSummary } from './client-format.js';

const PAGE_SIZE = 25;

function readFilters(parameters: URLSearchParams): ClientListParameters {
  const type = parameters.get('type');
  const state = parameters.get('state');
  const manager = parameters.get('manager');
  const q = parameters.get('q');
  return {
    ...(q === null || q.length === 0 ? {} : { q }),
    ...(type === 'individual' || type === 'business' ? { type } : {}),
    ...(manager === null || manager.length === 0 ? {} : { manager }),
    state: state === 'archived' || state === 'all' ? state : 'active',
  };
}

/**
 * Client directory. Search and filters live in the URL so a filtered list can
 * be bookmarked and the back button restores it. Filtering, search, and
 * paging all happen on the server; archived clients are hidden by default.
 */
export function ClientsPage() {
  const { can } = useSession();
  const [parameters, setParameters] = useSearchParams();
  const filters = readFilters(parameters);
  const filterKey = parameters.toString();
  const [clients, setClients] = useState<readonly ClientListItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<readonly ClientAssignee[]>([]);
  const [searchText, setSearchText] = useState(filters.q ?? '');
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listClientAssignees(controller.signal)
      .then((result) => {
        setAssignees(result.assignees);
      })
      .catch(() => {
        // The manager filter falls back to "any"; the list itself still works.
      });
    return () => {
      controller.abort();
    };
  }, []);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setClients(null);
      setNotice(null);
      try {
        const result = await listClients(
          { ...readFilters(new URLSearchParams(filterKey)), limit: PAGE_SIZE },
          signal,
        );
        setClients(result.clients);
        setCursor(result.nextCursor);
      } catch (error) {
        if (!signal.aborted) {
          setClients([]);
          setNotice(toErrorNotice(error, 'Could not load clients'));
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

  function updateFilter(name: string, value: string): void {
    const next = new URLSearchParams(parameters);
    if (value.length === 0) {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    setParameters(next);
  }

  function submitSearch(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    updateFilter('q', searchText.trim());
  }

  function clearFilters(): void {
    setSearchText('');
    setParameters(new URLSearchParams());
  }

  async function loadMore(): Promise<void> {
    if (cursor === null) {
      return;
    }
    setLoadingMore(true);
    setNotice(null);
    try {
      const result = await listClients({ ...filters, limit: PAGE_SIZE, cursor });
      setClients((current) => [...(current ?? []), ...result.clients]);
      setCursor(result.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more clients'));
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered =
    filters.q !== undefined ||
    filters.type !== undefined ||
    filters.manager !== undefined ||
    filters.state !== 'active';
  const canManage = can('clients.manage');

  return (
    <section aria-labelledby="clients-heading">
      <PageHeader
        id="clients-heading"
        title="Clients"
        description="Search by client code, name, phone, email, or an exact CNIC/NTN."
        actions={
          canManage ? (
            <Link to={ROUTE_PATHS.newClient} className={buttonVariants()}>
              <Plus aria-hidden="true" />
              New client
            </Link>
          ) : undefined
        }
      />
      {!can('clients.read_all') && (
        <InfoNotice>You see the clients assigned to you as manager.</InfoNotice>
      )}

      <form
        role="search"
        aria-label="Clients"
        onSubmit={submitSearch}
        className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end"
      >
        <Field>
          <FieldLabel htmlFor="client-search">Search</FieldLabel>
          <Input
            id="client-search"
            type="search"
            maxLength={100}
            value={searchText}
            placeholder="Code, name, phone, email, CNIC or NTN"
            onChange={(event) => {
              setSearchText(event.target.value);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="client-type-filter">Type</FieldLabel>
          <NativeSelect
            id="client-type-filter"
            className="w-full"
            value={filters.type ?? ''}
            onChange={(event) => {
              updateFilter('type', event.target.value);
            }}
          >
            <NativeSelectOption value="">All types</NativeSelectOption>
            {(Object.keys(CLIENT_TYPE_LABELS) as ClientType[]).map((type) => (
              <NativeSelectOption key={type} value={type}>
                {CLIENT_TYPE_LABELS[type]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="client-manager-filter">Manager</FieldLabel>
          <NativeSelect
            id="client-manager-filter"
            className="w-full"
            value={filters.manager ?? ''}
            onChange={(event) => {
              updateFilter('manager', event.target.value);
            }}
          >
            <NativeSelectOption value="">Any manager</NativeSelectOption>
            <NativeSelectOption value="unassigned">Unassigned</NativeSelectOption>
            {assignees.map((assignee) => (
              <NativeSelectOption key={assignee.id} value={assignee.id}>
                {assignee.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="client-state-filter">Status</FieldLabel>
          <NativeSelect
            id="client-state-filter"
            className="w-full"
            value={filters.state ?? 'active'}
            onChange={(event) => {
              updateFilter('state', event.target.value === 'active' ? '' : event.target.value);
            }}
          >
            <NativeSelectOption value="active">Active</NativeSelectOption>
            <NativeSelectOption value="archived">Archived</NativeSelectOption>
            <NativeSelectOption value="all">Active and archived</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Button type="submit">
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>

      {notice !== null && <ErrorAlert notice={notice} />}

      {clients === null ? (
        <LoadingMessage>Loading clients…</LoadingMessage>
      ) : (
        <Card className="py-0">
          {clients.length === 0 ? (
            filtered ? (
              <EmptyState title="No clients match these filters">
                Try a different search, or{' '}
                <Button type="button" variant="link" className="h-auto p-0" onClick={clearFilters}>
                  clear all filters
                </Button>
                .
              </EmptyState>
            ) : (
              <EmptyState title="No clients yet">
                {canManage
                  ? 'Create the first client record to start managing their work.'
                  : 'Clients appear here once a manager creates or assigns them.'}
              </EmptyState>
            )
          ) : (
            <Table>
              <TableCaption className="sr-only">
                {`${String(clients.length)} clients shown${cursor === null ? '' : '; more are available'}.`}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Identifier</TableHead>
                  <TableHead>Primary contact</TableHead>
                  <TableHead>Manager</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell>
                      <Link
                        to={clientPath(client.id)}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {client.displayName}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">
                        {client.clientCode}
                      </div>
                    </TableCell>
                    <TableCell>{CLIENT_TYPE_LABELS[client.type]}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {client.cnicMasked ?? client.ntnMasked ?? '—'}
                    </TableCell>
                    <TableCell className="max-w-56 truncate">
                      {client.primaryContact === null ? '—' : contactSummary(client.primaryContact)}
                    </TableCell>
                    <TableCell>{client.assignedManager?.displayName ?? 'Unassigned'}</TableCell>
                    <TableCell>
                      <Badge variant={client.state === 'active' ? 'success' : 'secondary'}>
                        {client.state === 'active' ? 'Active' : 'Archived'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}

      {cursor !== null && clients !== null && clients.length > 0 && (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {loadingMore ? 'Loading…' : 'Load more clients'}
          </Button>
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { AuditEvent } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listAuditEvents } from '../auth-client.js';
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  type ErrorNotice,
} from '../components/feedback.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { useSession } from '../session/session-context.js';
import { toErrorNotice } from './error-notice.js';

const PAGE_SIZE = 25;

export function AuditPage() {
  const { can } = useSession();
  const [events, setEvents] = useState<readonly AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await listAuditEvents({ limit: PAGE_SIZE }, signal);
      setEvents(result.events);
      setCursor(result.nextCursor);
      setNotice(null);
    } catch (error) {
      if (signal?.aborted !== true) {
        setNotice(toErrorNotice(error, 'Could not load audit history'));
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  if (!can('audit.read')) {
    return <PermissionDenied />;
  }

  async function loadMore(): Promise<void> {
    if (cursor === null) {
      return;
    }
    setLoadingMore(true);
    setNotice(null);
    try {
      const result = await listAuditEvents({ limit: PAGE_SIZE, cursor });
      setEvents((current) => [...(current ?? []), ...result.events]);
      setCursor(result.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more audit history'));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section aria-labelledby="audit-heading">
      <PageHeader
        id="audit-heading"
        title="Audit history"
        description="Audit events are append-only. They do not include passwords, tokens, or MFA secrets."
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {events === null ? (
        notice === null && <LoadingMessage>Loading audit history…</LoadingMessage>
      ) : (
        <Card className="gap-0 py-0">
          {events.length === 0 ? (
            <EmptyState title="No audit events yet">
              Sign-ins, user changes and setting changes will appear here.
            </EmptyState>
          ) : (
            <Table>
              <TableCaption className="sr-only">Audit events, most recent first</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col">Action</TableHead>
                  <TableHead scope="col">Entity</TableHead>
                  <TableHead scope="col">Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(event.occurredAt).toLocaleString()}
                    </TableCell>
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

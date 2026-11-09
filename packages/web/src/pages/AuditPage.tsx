import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent } from '@taxdesk/shared';
import { listAuditEvents } from '../auth-client.js';
import {
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  type ErrorNotice,
} from '../components/feedback.js';
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
      <h1 id="audit-heading">Audit history</h1>
      <p className="muted small">
        Audit events are append-only. They do not include passwords, tokens, or MFA secrets.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      {events === null ? (
        <LoadingMessage>Loading audit history…</LoadingMessage>
      ) : events.length === 0 ? (
        <p className="muted">No audit events yet.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <caption className="muted small">Most recent first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Request</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.occurredAt).toLocaleString()}</td>
                    <td>
                      <code>{event.action}</code>
                    </td>
                    <td>
                      {event.entityType}
                      {event.entityId === null ? '' : ` · ${event.entityId}`}
                    </td>
                    <td>
                      <code className="break-all">{event.requestId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor !== null && (
            <button
              type="button"
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

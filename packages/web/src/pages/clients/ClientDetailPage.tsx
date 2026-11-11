import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Archive, ArchiveRestore, LoaderCircle, Pencil } from 'lucide-react';
import type { Client, ClientActivity } from '@taxdesk/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DocumentTitle } from '@/lib/document-title';
import { ApiError } from '../../api-client.js';
import { getClient, listClientActivity, setClientArchived } from '../../client-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ClientCasesCard } from '../cases/ClientCasesCard.js';
import { ROUTE_PATHS, editClientPath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';
import {
  ACTIVITY_LABELS,
  CLIENT_FIELD_LABELS,
  CLIENT_TYPE_LABELS,
  formatDateTime,
} from './client-format.js';

const ACTIVITY_PAGE = 20;

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function ActivityEntry({ event }: { event: ClientActivity }) {
  return (
    <li className="border-b py-3 last:border-b-0">
      <p className="text-sm">
        <span className="font-medium">{event.actor?.displayName ?? 'System'}</span>{' '}
        {ACTIVITY_LABELS[event.action].toLowerCase()}
      </p>
      <p className="text-xs text-muted-foreground">
        <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
      </p>
      {event.changedFields.length > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          Changed: {event.changedFields.map((field) => CLIENT_FIELD_LABELS[field]).join(', ')}
        </p>
      )}
      {(event.cnicMasked !== null || event.ntnMasked !== null) && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {[
            event.cnicMasked === null ? null : `CNIC ${event.cnicMasked}`,
            event.ntnMasked === null ? null : `NTN ${event.ntnMasked}`,
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </p>
      )}
      {event.overrideReason !== null && (
        <p className="mt-1 text-sm">
          <span className="text-muted-foreground">Reason:</span> {event.overrideReason}
        </p>
      )}
    </li>
  );
}

/**
 * One client record: summary, contacts, assignment, and its safe activity
 * history. National identifiers are only ever shown masked; the API never
 * returns them in full.
 */
export function ClientDetailPage() {
  const { clientId = '' } = useParams();
  const location = useLocation();
  const { can } = useSession();
  const [client, setClient] = useState<Client | null>(null);
  const [activity, setActivity] = useState<readonly ClientActivity[] | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(
    typeof (location.state as { notice?: unknown } | null)?.notice === 'string'
      ? (location.state as { notice: string }).notice
      : null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changingState, setChangingState] = useState(false);
  const [loadingActivity, setLoadingActivity] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [record, history] = await Promise.all([
          getClient(clientId, signal),
          listClientActivity(clientId, { limit: ACTIVITY_PAGE }, signal),
        ]);
        setClient(record);
        setActivity(history.events);
        setActivityCursor(history.nextCursor);
      } catch (error) {
        if (signal?.aborted !== true) {
          setNotice(toErrorNotice(error, 'Could not load this client'));
        }
      }
    },
    [clientId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  async function changeState(): Promise<void> {
    if (client === null) {
      return;
    }
    const archiving = client.state === 'active';
    setChangingState(true);
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await setClientArchived(client.id, archiving, client.version);
      setClient(updated);
      setSuccess(archiving ? 'Client archived.' : 'Client restored.');
      const history = await listClientActivity(client.id, { limit: ACTIVITY_PAGE });
      setActivity(history.events);
      setActivityCursor(history.nextCursor);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        setNotice({
          title: 'This client changed',
          message:
            'Someone else updated this client while you were viewing it. The latest version is shown below; review it and try again.',
          ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        });
        await load();
      } else {
        setNotice(toErrorNotice(error, archiving ? 'Could not archive' : 'Could not restore'));
      }
    } finally {
      setChangingState(false);
      setConfirmOpen(false);
    }
  }

  async function loadMoreActivity(): Promise<void> {
    if (activityCursor === null) {
      return;
    }
    setLoadingActivity(true);
    try {
      const history = await listClientActivity(clientId, {
        limit: ACTIVITY_PAGE,
        cursor: activityCursor,
      });
      setActivity((current) => [...(current ?? []), ...history.events]);
      setActivityCursor(history.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more activity'));
    } finally {
      setLoadingActivity(false);
    }
  }

  if (client === null) {
    return (
      <section aria-labelledby="client-heading">
        <DocumentTitle title="Client" />
        <PageHeader id="client-heading" title="Client" />
        {notice !== null ? (
          <>
            <ErrorAlert notice={notice} />
            <Link to={ROUTE_PATHS.clients} className={buttonVariants({ variant: 'outline' })}>
              Back to clients
            </Link>
          </>
        ) : (
          <LoadingMessage>Loading client…</LoadingMessage>
        )}
      </section>
    );
  }

  const canManage = can('clients.manage');
  const archived = client.state === 'archived';

  return (
    <section aria-labelledby="client-heading">
      <DocumentTitle title={client.displayName} />
      <PageHeader
        id="client-heading"
        title={client.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{client.clientCode}</span>
            <span aria-hidden="true">·</span>
            <span>{CLIENT_TYPE_LABELS[client.type]}</span>
            <Badge variant={archived ? 'secondary' : 'success'}>
              {archived ? 'Archived' : 'Active'}
            </Badge>
          </span>
        }
        actions={
          canManage ? (
            <>
              {!archived && (
                <Link
                  to={editClientPath(client.id)}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Link>
              )}
              <Button
                type="button"
                variant={archived ? 'outline' : 'destructive'}
                onClick={() => {
                  setConfirmOpen(true);
                }}
              >
                {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
                {archived ? 'Restore' : 'Archive'}
              </Button>
            </>
          ) : undefined
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {archived && client.archivedAt !== null && (
        <InfoNotice tone="warning">
          Archived on {formatDateTime(client.archivedAt)}. Archived clients are hidden from default
          search and selection lists and cannot be edited until restored.
        </InfoNotice>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Summary</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <Detail term="Legal name">{client.legalName}</Detail>
                <Detail term="Display name">{client.displayName}</Detail>
                {client.type === 'individual' && (
                  <Detail term="CNIC">
                    <span className="font-mono">{client.cnicMasked ?? '—'}</span>
                  </Detail>
                )}
                <Detail term="NTN">
                  <span className="font-mono">{client.ntnMasked ?? 'Not recorded'}</span>
                </Detail>
                <Detail term="Assigned manager">
                  {client.assignedManager?.displayName ?? 'Unassigned'}
                </Detail>
                <Detail term="Created">{formatDateTime(client.createdAt)}</Detail>
                <Detail term="Last updated">{formatDateTime(client.updatedAt)}</Detail>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Contacts</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {client.contacts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No contacts recorded.</p>
              ) : (
                <ul className="divide-y">
                  {client.contacts.map((contact) => (
                    <li key={contact.id} className="py-3 first:pt-0 last:pb-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {contact.name}
                        {contact.isPrimary && <Badge variant="outline">Primary</Badge>}
                      </p>
                      {contact.relationship !== null && (
                        <p className="text-sm text-muted-foreground">{contact.relationship}</p>
                      )}
                      {contact.email !== null && (
                        <p className="text-sm">
                          <a
                            className="text-primary underline-offset-4 hover:underline"
                            href={`mailto:${contact.email}`}
                          >
                            {contact.email}
                          </a>
                        </p>
                      )}
                      {contact.phone !== null && <p className="text-sm">{contact.phone}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2 className="text-base font-semibold">Notes</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {client.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No notes.</p>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{client.notes}</p>
              )}
            </CardContent>
          </Card>

          <ClientCasesCard clientId={client.id} archived={archived} />
        </div>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">Activity</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activity === null || activity.length === 0 ? (
              <EmptyState title="No activity yet" />
            ) : (
              <ol aria-label="Client activity, newest first">
                {activity.map((event) => (
                  <ActivityEntry key={event.id} event={event} />
                ))}
              </ol>
            )}
            {activityCursor !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={loadingActivity}
                aria-busy={loadingActivity}
                onClick={() => void loadMoreActivity()}
              >
                {loadingActivity ? 'Loading…' : 'Show older activity'}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!changingState) {
            setConfirmOpen(open);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archived ? `Restore ${client.displayName}?` : `Archive ${client.displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archived
                ? 'The client returns to default search and selection lists and can be edited again.'
                : 'The client is hidden from default search and selection lists and cannot be edited until restored. Its record and activity history are kept.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changingState}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant={archived ? 'default' : 'destructive'}
              disabled={changingState}
              aria-busy={changingState}
              onClick={() => void changeState()}
            >
              {changingState && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {archived ? 'Restore client' : 'Archive client'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

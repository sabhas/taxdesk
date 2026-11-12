import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Activity, LoaderCircle, Plug, RefreshCw, Unplug } from 'lucide-react';
import {
  StorageCallbackResultSchema,
  type ReconciliationRun,
  type StorageConnection,
} from '@taxdesk/shared';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '../../api-client.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import {
  authorizeStorage,
  checkStorage,
  disconnectStorage,
  getStorageConnection,
  listReconciliationRuns,
  runReconciliation,
} from '../../storage-api.js';
import { toErrorNotice } from '../error-notice.js';
import { formatDateTime } from '../cases/case-format.js';
import {
  CALLBACK_RESULT_TEXT,
  CONNECTION_STATUS_BADGE,
  CONNECTION_STATUS_LABELS,
  HEALTH_REASON_TEXT,
  NEXT_ACTION_TEXT,
} from '../documents/document-format.js';

/** Navigates to the provider consent page. Indirected so tests can observe it. */
export const storageNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

type Busy = 'connect' | 'check' | 'disconnect' | 'reconcile' | null;

/**
 * Administrator storage settings (TD-403, TD-404, TD-410): connect, check,
 * reconnect, or disconnect the firm's document storage, and run
 * reconciliation. The API holds every token; this page shows metadata only.
 */
export function StorageSettingsPage() {
  const headingId = useId();
  const [parameters, setParameters] = useSearchParams();
  const [connection, setConnection] = useState<StorageConnection | null>(null);
  const [runs, setRuns] = useState<readonly ReconciliationRun[] | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const parsedResult = StorageCallbackResultSchema.safeParse(parameters.get('result'));
  const callback = parsedResult.success ? CALLBACK_RESULT_TEXT[parsedResult.data] : null;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const current = await getStorageConnection(signal);
      setConnection(current);
      if (current.permissions.manage) {
        const list = await listReconciliationRuns(signal);
        setRuns(list.runs);
      }
    } catch (error) {
      if (signal?.aborted !== true) {
        setNotice(toErrorNotice(error, 'Could not load storage settings'));
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

  function dismissCallback(): void {
    const next = new URLSearchParams(parameters);
    next.delete('result');
    setParameters(next, { replace: true });
  }

  async function connect(): Promise<void> {
    setBusy('connect');
    setNotice(null);
    setSuccess(null);
    try {
      const { authorizationUrl } = await authorizeStorage();
      storageNavigation.assign(authorizationUrl);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not start the connection'));
      setBusy(null);
    }
  }

  async function check(): Promise<void> {
    setBusy('check');
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await checkStorage();
      setConnection(updated);
      setSuccess(
        updated.status === 'healthy'
          ? 'Storage is connected and working.'
          : `Storage check finished: ${CONNECTION_STATUS_LABELS[updated.status].toLowerCase()}.`,
      );
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not check storage'));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(): Promise<void> {
    if (connection?.version === null || connection === null) return;
    setBusy('disconnect');
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await disconnectStorage(connection.version);
      setConnection(updated);
      setConfirmDisconnect(false);
      setSuccess('Storage was disconnected. Existing document records are kept.');
    } catch (error) {
      setConfirmDisconnect(false);
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        setNotice({
          title: 'The connection changed',
          message:
            'The storage connection changed since this page loaded. The latest state is shown; review it and try again.',
          requestId: error.requestId,
        });
        await load();
      } else {
        setNotice(toErrorNotice(error, 'Could not disconnect storage'));
      }
    } finally {
      setBusy(null);
    }
  }

  async function reconcile(): Promise<void> {
    setBusy('reconcile');
    setNotice(null);
    setSuccess(null);
    try {
      const run = await runReconciliation();
      setRuns((current) => [run, ...(current ?? [])].slice(0, 10));
      setSuccess(
        `Reconciliation checked ${String(run.checkedCount)} documents: ${String(run.missingCount)} missing, ${String(run.movedCount)} moved.`,
      );
      // The run may have changed connection health.
      setConnection(await getStorageConnection());
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not run reconciliation'));
    } finally {
      setBusy(null);
    }
  }

  if (connection === null) {
    return (
      <section aria-labelledby={headingId}>
        <PageHeader id={headingId} title="Document storage" />
        {notice !== null ? (
          <ErrorAlert notice={notice} />
        ) : (
          <LoadingMessage>Loading storage settings…</LoadingMessage>
        )}
      </section>
    );
  }

  const manage = connection.permissions.manage;
  const connected = connection.status !== 'not_connected';
  const needsReconnect =
    connection.status === 'reconnect_required' || connection.status === 'unavailable';

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Document storage"
        description="Where TaxDesk keeps client documents. Staff never sign in to the storage account; TaxDesk holds the connection."
      />
      {callback !== null &&
        (callback.tone === 'success' ? (
          <SuccessNotice>
            <strong>{callback.title}.</strong> {callback.message}{' '}
            <Button type="button" variant="link" size="sm" onClick={dismissCallback}>
              Dismiss
            </Button>
          </SuccessNotice>
        ) : (
          <ErrorAlert notice={{ title: callback.title, message: callback.message }} />
        ))}
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="flex items-center gap-2 text-base font-semibold">
                Connection
                <Badge variant={CONNECTION_STATUS_BADGE[connection.status]}>
                  {CONNECTION_STATUS_LABELS[connection.status]}
                </Badge>
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!connection.configured && (
              <InfoNotice tone="warning">
                This deployment is not configured for document storage. An operator must set the
                storage provider and encryption secrets before it can be connected.
              </InfoNotice>
            )}
            {connection.healthReason !== null && (
              <p className="text-sm" role="status">
                {HEALTH_REASON_TEXT[connection.healthReason]}
              </p>
            )}
            <dl className="space-y-3">
              <Detail term="Provider">
                {connection.providerType === 'onedrive'
                  ? 'Microsoft OneDrive'
                  : connection.providerType === 'fake'
                    ? 'Test storage'
                    : 'None'}
              </Detail>
              <Detail term="Account">{connection.accountLabel ?? '—'}</Detail>
              <Detail term="Connected">
                {connection.connectedAt === null
                  ? '—'
                  : `${formatDateTime(connection.connectedAt)}${
                      connection.connectedByName === null ? '' : ` by ${connection.connectedByName}`
                    }`}
              </Detail>
              <Detail term="Last checked">
                {connection.lastCheckedAt === null ? '—' : formatDateTime(connection.lastCheckedAt)}
              </Detail>
            </dl>
            {manage ? (
              <div className="flex flex-wrap gap-2">
                {(!connected || needsReconnect) && (
                  <Button
                    type="button"
                    disabled={busy !== null || !connection.configured}
                    aria-busy={busy === 'connect'}
                    onClick={() => void connect()}
                  >
                    {busy === 'connect' ? (
                      <LoaderCircle aria-hidden="true" className="animate-spin" />
                    ) : (
                      <Plug aria-hidden="true" />
                    )}
                    {connected ? 'Reconnect storage' : 'Connect storage'}
                  </Button>
                )}
                {connected && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy !== null}
                    aria-busy={busy === 'check'}
                    onClick={() => void check()}
                  >
                    {busy === 'check' ? (
                      <LoaderCircle aria-hidden="true" className="animate-spin" />
                    ) : (
                      <RefreshCw aria-hidden="true" />
                    )}
                    Check now
                  </Button>
                )}
                {connected && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmDisconnect(true);
                    }}
                  >
                    <Unplug aria-hidden="true" />
                    Disconnect
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Only an administrator can change the storage connection.
              </p>
            )}
          </CardContent>
        </Card>

        {manage && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>
                <h2 className="text-base font-semibold">Reconciliation</h2>
              </CardTitle>
              <Button
                type="button"
                size="sm"
                disabled={busy !== null || !connected}
                aria-busy={busy === 'reconcile'}
                onClick={() => void reconcile()}
              >
                {busy === 'reconcile' ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Activity aria-hidden="true" />
                )}
                Run reconciliation
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Checks every stored document against the storage account and marks missing or moved
                files. Nothing is deleted.
              </p>
              {runs === null ? (
                <LoadingMessage>Loading reconciliation runs…</LoadingMessage>
              ) : runs.length === 0 ? (
                <EmptyState title="No reconciliation runs yet" />
              ) : (
                <>
                  {runs[0] !== undefined && (
                    <p className="text-sm" aria-live="polite">
                      <strong>Next action:</strong> {NEXT_ACTION_TEXT[runs[0].nextAction]}
                    </p>
                  )}
                  <Table>
                    <TableCaption className="sr-only">
                      Reconciliation runs, most recent first
                    </TableCaption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Run</TableHead>
                        <TableHead className="text-right">Checked</TableHead>
                        <TableHead className="text-right">Missing</TableHead>
                        <TableHead className="text-right">Moved</TableHead>
                        <TableHead className="text-right">Recovered</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => (
                        <TableRow key={run.id}>
                          <TableCell>
                            <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>
                            {run.state === 'failed' && (
                              <Badge variant="destructive" className="ml-2">
                                Failed
                              </Badge>
                            )}
                            {run.startedByName !== null && (
                              <span className="block text-xs text-muted-foreground">
                                by {run.startedByName}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{run.checkedCount}</TableCell>
                          <TableCell className="text-right">{run.missingCount}</TableCell>
                          <TableCell className="text-right">{run.movedCount}</TableCell>
                          <TableCell className="text-right">{run.recoveredCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <AlertDialog
        open={confirmDisconnect}
        onOpenChange={(open) => {
          if (busy === null) setConfirmDisconnect(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect document storage?</AlertDialogTitle>
            <AlertDialogDescription>
              TaxDesk forgets its access to the storage account. Uploads and document opens stop
              until an administrator connects storage again. Files in the storage account and
              document records in TaxDesk are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={busy !== null}
              aria-busy={busy === 'disconnect'}
              onClick={() => void disconnect()}
            >
              {busy === 'disconnect' && (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              )}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

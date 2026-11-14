import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download, LoaderCircle, RefreshCw, Trash2, Upload } from 'lucide-react';
import {
  IMPORT_LIMITS,
  type ImportBatch,
  type ImportDecision,
  type ImportRow,
  type ImportRowAction,
} from '@taxdesk/shared';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { DocumentTitle } from '@/lib/document-title';
import { ApiError, newRequestId } from '../../api-client.js';
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
  commitImport,
  decideImportRow,
  discardImport,
  forgetImportFile,
  getImportBatch,
  importRowsCsvUrl,
  listImportRows,
  rememberImportFile,
  rememberedImportFile,
  revalidateImport,
} from '../../import-api.js';
import { ROUTE_PATHS } from '../../routes.js';
import { money } from '../billing/billing-format.js';
import { formatDateTime } from '../cases/case-format.js';
import { toErrorNotice } from '../error-notice.js';
import {
  ACTION_BADGE,
  ACTION_LABELS,
  KIND_LABELS,
  OUTCOME_LABELS,
  STATUS_BADGE,
  STATUS_LABELS,
  readFileText,
} from './import-format.js';

type Busy = 'revalidate' | 'commit' | 'discard' | null;

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: string | undefined;
}) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</dd>
    </div>
  );
}

/**
 * One import batch (TD-702–TD-704): the dry-run plan, row errors and possible
 * duplicates with their decisions, the commit with its reconciliation, and
 * exports. Commit and revalidate send the same file again; the API checks it
 * against the stored checksum.
 */
export function ImportBatchPage() {
  const headingId = useId();
  const { batchId = '' } = useParams();
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [content, setContent] = useState<string | null>(() => rememberedImportFile(batchId));
  const [confirm, setConfirm] = useState<'commit' | 'discard' | null>(null);
  // One key per commit intent, reused on retry so the server resumes rather than repeats.
  const [commitKey, setCommitKey] = useState(() => newRequestId());
  const [rowsVersion, setRowsVersion] = useState(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setBatch(await getImportBatch(batchId, signal));
      } catch (error) {
        if (signal?.aborted !== true) {
          setNotice(toErrorNotice(error, 'Could not load the import batch'));
        }
      }
    },
    [batchId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  function adopt(next: ImportBatch): void {
    setBatch(next);
    setRowsVersion((value) => value + 1);
  }

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>, title: string) {
    setBusy(kind);
    setNotice(null);
    setSuccess(null);
    try {
      await action();
    } catch (error) {
      setNotice(toErrorNotice(error, title));
      if (error instanceof ApiError && (error.status === 412 || error.status === 409)) {
        await load();
        setRowsVersion((value) => value + 1);
      }
    } finally {
      setBusy(null);
    }
  }

  if (batch === null) {
    return (
      <section aria-labelledby={headingId}>
        <PageHeader id={headingId} title="Import batch" />
        {notice !== null ? (
          <ErrorAlert notice={notice} />
        ) : (
          <LoadingMessage>Loading the import batch…</LoadingMessage>
        )}
      </section>
    );
  }

  const editable = batch.status === 'validated' || batch.status === 'blocked';
  const opening = batch.kind === 'opening_balances';
  const recon = batch.reconciliation;

  return (
    <section aria-labelledby={headingId}>
      <DocumentTitle title={`Import ${batch.batchCode}`} />
      <Link
        to={ROUTE_PATHS.imports}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        All imports
      </Link>
      <PageHeader
        id={headingId}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {batch.batchCode}
            <Badge variant={STATUS_BADGE[batch.status]}>{STATUS_LABELS[batch.status]}</Badge>
          </span>
        }
        description={`${KIND_LABELS[batch.kind]} · ${batch.fileName} · ${String(batch.rowCount)} rows · validated ${formatDateTime(batch.validatedAt)}`}
        actions={
          <>
            <a
              href={importRowsCsvUrl(batch.id, 'exceptions')}
              download
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              <Download aria-hidden="true" />
              Exceptions CSV
            </a>
            {batch.status === 'committed' && (
              <a
                href={importRowsCsvUrl(batch.id, 'all')}
                download
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                <Download aria-hidden="true" />
                Lineage CSV
              </a>
            )}
          </>
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base font-semibold">
                {batch.status === 'committed' ? 'Result' : 'Dry-run plan'}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Create" value={batch.plan.create} />
              <Stat label="Update" value={batch.plan.update} />
              <Stat label="Skip" value={batch.plan.skip} />
              <Stat
                label="Possible duplicates"
                value={batch.plan.review}
                tone={batch.plan.review > 0 ? 'text-warning' : undefined}
              />
              <Stat
                label="Errors"
                value={batch.plan.error}
                tone={batch.plan.error > 0 ? 'text-destructive' : undefined}
              />
            </dl>
            {(batch.status === 'committing' || batch.status === 'committed') && (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Stat label="Created" value={batch.outcomes.created} />
                <Stat label="Updated" value={batch.outcomes.updated} />
                <Stat label="Skipped" value={batch.outcomes.skipped} />
                <Stat
                  label="Failed"
                  value={batch.outcomes.failed}
                  tone={batch.outcomes.failed > 0 ? 'text-destructive' : undefined}
                />
                <Stat label="Pending" value={batch.outcomes.pending} />
              </dl>
            )}
            {opening && (
              <p className="text-sm">
                File total {money(recon.sourceAmountMinor ?? 0)}
                {batch.status === 'committed' &&
                  ` · invoiced ${money(recon.importedAmountMinor ?? 0)} · already imported or skipped ${money(recon.skippedAmountMinor ?? 0)}`}
              </p>
            )}
            {batch.status === 'committed' &&
              (recon.balanced ? (
                <InfoNotice>
                  Reconciled: all {recon.sourceRows} rows are accounted for
                  {opening ? ' and the amounts add up' : ''}.
                </InfoNotice>
              ) : (
                <InfoNotice tone="warning">
                  Not reconciled: {recon.accountedRows} of {recon.sourceRows} rows are accounted for
                  and {batch.outcomes.failed} failed. Export the exceptions and correct them in a
                  new file.
                </InfoNotice>
              ))}
            {batch.status === 'blocked' && (
              <InfoNotice tone="warning">
                Fix every error in the source file and run a new dry run, and decide each possible
                duplicate below, before committing.
              </InfoNotice>
            )}
            {batch.status === 'committing' && (
              <InfoNotice tone="warning">
                The commit was interrupted. Choose the same file and commit again to resume; rows
                already imported are not imported twice.
              </InfoNotice>
            )}
          </CardContent>
        </Card>

        {(editable || batch.status === 'committing') && (
          <ActionsCard
            batch={batch}
            content={content}
            busy={busy}
            onFile={(text) => {
              setContent(text);
              rememberImportFile(batch.id, text);
            }}
            onRevalidate={() =>
              void run(
                'revalidate',
                async () => {
                  adopt(await revalidateImport(batch, content ?? ''));
                  setSuccess('The batch was checked again against current records.');
                },
                'Could not revalidate the batch',
              )
            }
            onCommit={() => {
              setConfirm('commit');
            }}
            onDiscard={() => {
              setConfirm('discard');
            }}
          />
        )}

        <RowsCard batch={batch} refreshKey={rowsVersion} onDecided={adopt} />
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'discard' ? 'Discard this batch?' : `Commit ${batch.batchCode}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'discard'
                ? 'Nothing was imported from this batch. Discarding keeps its history and lets you upload the same file again.'
                : `${String(batch.plan.create)} records will be created and ${String(batch.plan.update)} updated, in transactions of ${String(IMPORT_LIMITS.commitChunkRows)} rows. Imported records are audited and cannot be removed by undoing the import.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant={confirm === 'discard' ? 'destructive' : 'default'}
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action === 'discard') {
                  void run(
                    'discard',
                    async () => {
                      adopt(await discardImport(batch));
                      forgetImportFile(batch.id);
                      setSuccess('The batch was discarded.');
                    },
                    'Could not discard the batch',
                  );
                } else {
                  void run(
                    'commit',
                    async () => {
                      const next = await commitImport(batch, content ?? '', commitKey);
                      adopt(next);
                      forgetImportFile(batch.id);
                      setCommitKey(newRequestId());
                      setSuccess(
                        `Import committed: ${String(next.outcomes.created)} created, ${String(next.outcomes.updated)} updated, ${String(next.outcomes.skipped)} skipped.`,
                      );
                    },
                    'The import did not finish',
                  );
                }
              }}
            >
              {confirm === 'discard' ? 'Discard batch' : 'Commit import'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ActionsCard({
  batch,
  content,
  busy,
  onFile,
  onRevalidate,
  onCommit,
  onDiscard,
}: {
  batch: ImportBatch;
  content: string | null;
  busy: Busy;
  onFile: (content: string) => void;
  onRevalidate: () => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const id = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const spinner = (kind: Busy) =>
    busy === kind ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Actions</h2>
        </CardTitle>
        <CardDescription>
          TaxDesk does not keep the file. Revalidating or committing sends the same file again and
          is refused if it differs from the one checked in the dry run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {content === null && (
          <Field data-invalid={fileError !== null}>
            <FieldLabel htmlFor={`${id}-file`}>Choose {batch.fileName} again</FieldLabel>
            <Input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              aria-describedby={`${id}-help`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                void readFileText(file)
                  .then((text) => {
                    setFileError(null);
                    onFile(text);
                  })
                  .catch(() => {
                    setFileError('The file could not be read.');
                  });
              }}
            />
            <FieldDescription id={`${id}-help`}>Needed to revalidate or commit.</FieldDescription>
            <FieldError>{fileError}</FieldError>
          </Field>
        )}
        <div className="flex flex-wrap gap-2">
          {batch.canCommit && (
            <Button type="button" disabled={busy !== null || content === null} onClick={onCommit}>
              {spinner('commit') ?? <Upload aria-hidden="true" />}
              {batch.status === 'committing' ? 'Resume commit' : 'Commit import'}
            </Button>
          )}
          {batch.status !== 'committing' && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null || content === null}
                onClick={onRevalidate}
              >
                {spinner('revalidate') ?? <RefreshCw aria-hidden="true" />}
                Revalidate
              </Button>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={onDiscard}>
                {spinner('discard') ?? <Trash2 aria-hidden="true" />}
                Discard
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const ROW_FILTERS: readonly { value: ImportRowAction | ''; label: string }[] = [
  { value: '', label: 'All rows' },
  { value: 'error', label: 'Errors' },
  { value: 'review', label: 'Possible duplicates' },
  { value: 'skip', label: 'Skipped' },
  { value: 'update', label: 'Updates' },
  { value: 'create', label: 'Creates' },
];

function RowsCard({
  batch,
  refreshKey,
  onDecided,
}: {
  batch: ImportBatch;
  refreshKey: number;
  onDecided: (batch: ImportBatch) => void;
}) {
  const id = useId();
  const [filter, setFilter] = useState<ImportRowAction | ''>(
    batch.plan.error > 0 ? 'error' : batch.plan.review > 0 ? 'review' : '',
  );
  const [rows, setRows] = useState<readonly ImportRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [deciding, setDeciding] = useState<ImportRow | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const page = await listImportRows(
          batch.id,
          { action: filter === '' ? undefined : filter },
          signal,
        );
        setRows(page.rows);
        setCursor(page.nextCursor);
      } catch (error) {
        if (signal?.aborted !== true) setNotice(toErrorNotice(error, 'Could not load rows'));
      }
    },
    [batch.id, filter],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load, refreshKey]);

  async function more(): Promise<void> {
    try {
      const page = await listImportRows(batch.id, {
        action: filter === '' ? undefined : filter,
        cursor,
      });
      setRows((current) => [...(current ?? []), ...page.rows]);
      setCursor(page.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more rows'));
    }
  }

  const editable = batch.status === 'validated' || batch.status === 'blocked';

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Rows</h2>
        </CardTitle>
        <CardDescription>
          Row numbers match the spreadsheet: the header is row 1. Messages describe the problem
          without repeating the value.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field className="max-w-xs">
          <FieldLabel htmlFor={`${id}-filter`}>Show</FieldLabel>
          <NativeSelect
            id={`${id}-filter`}
            value={filter}
            onChange={(event) => {
              setRows(null);
              setFilter(event.target.value as ImportRowAction | '');
            }}
          >
            {ROW_FILTERS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {notice !== null && <ErrorAlert notice={notice} />}
        {rows === null ? (
          <LoadingMessage>Loading rows…</LoadingMessage>
        ) : rows.length === 0 ? (
          <EmptyState title="No rows match this filter" />
        ) : (
          <Table>
            <TableCaption className="sr-only">Import rows of {batch.batchCode}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Row</TableHead>
                <TableHead scope="col">Reference</TableHead>
                <TableHead scope="col">Plan</TableHead>
                <TableHead scope="col">Details</TableHead>
                <TableHead scope="col">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.rowNumber}>
                  <TableCell className="tabular-nums">{row.rowNumber}</TableCell>
                  <TableCell>
                    {row.externalRef === null ? '—' : <code>{row.externalRef}</code>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ACTION_BADGE[row.action]}>{ACTION_LABELS[row.action]}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {row.errors.length > 0 ? (
                      <ul className="space-y-1">
                        {row.errors.map((error) => (
                          <li key={`${error.column}-${error.code}`}>
                            <code>{error.column}</code>: {error.message}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      row.reasonMessage
                    )}
                    {row.match !== null && (
                      <p className="text-muted-foreground">Matches {row.match.code}</p>
                    )}
                    {row.decision !== null && (
                      <p className="text-muted-foreground">
                        Decided: {row.decision.decision === 'create' ? 'create anyway' : 'skip'} —{' '}
                        {row.decision.reason}
                        {row.decision.decidedBy === null
                          ? ''
                          : ` (${row.decision.decidedBy.displayName})`}
                      </p>
                    )}
                    {row.action === 'review' && editable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        onClick={() => {
                          setDeciding(row);
                        }}
                      >
                        {row.decision === null ? 'Decide' : 'Change decision'}
                        <span className="sr-only"> for row {row.rowNumber}</span>
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.outcome === null ? '—' : OUTCOME_LABELS[row.outcome]}
                    {row.record !== null && (
                      <p className="text-muted-foreground">{row.record.code}</p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {cursor !== null && (
          <Button variant="outline" onClick={() => void more()}>
            Show more rows
          </Button>
        )}
      </CardContent>
      <DecisionDialog
        batch={batch}
        row={deciding}
        onClose={() => {
          setDeciding(null);
        }}
        onDecided={(next) => {
          setDeciding(null);
          onDecided(next);
        }}
      />
    </Card>
  );
}

function DecisionDialog({
  batch,
  row,
  onClose,
  onDecided,
}: {
  batch: ImportBatch;
  row: ImportRow | null;
  onClose: () => void;
  onDecided: (batch: ImportBatch) => void;
}) {
  return (
    <AlertDialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent>
        {row !== null && (
          <DecisionBody batch={batch} row={row} onClose={onClose} onDecided={onDecided} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DecisionBody({
  batch,
  row,
  onClose,
  onDecided,
}: {
  batch: ImportBatch;
  row: ImportRow;
  onClose: () => void;
  onDecided: (batch: ImportBatch) => void;
}) {
  const id = useId();
  const [decision, setDecision] = useState<ImportDecision>(row.decision?.decision ?? 'skip');
  const [reason, setReason] = useState(row.decision?.reason ?? '');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(): Promise<void> {
    if (reason.trim().length < IMPORT_LIMITS.overrideReasonMin) {
      setReasonError(
        `Explain the decision in at least ${String(IMPORT_LIMITS.overrideReasonMin)} characters.`,
      );
      return;
    }
    setReasonError(null);
    setWorking(true);
    try {
      const result = await decideImportRow(batch, row.rowNumber, decision, reason.trim());
      onDecided(result.batch);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not save the decision'));
      setWorking(false);
    }
  }

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Row {row.rowNumber}: possible duplicate</AlertDialogTitle>
        <AlertDialogDescription>
          {row.match === null
            ? 'Another row in this file has the same name, email, or phone.'
            : `Client ${row.match.code} has the same name, email, or phone.`}{' '}
          Check both records, then decide. The reason is kept in the audit history.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {notice !== null && <ErrorAlert notice={notice} />}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Decision</legend>
        {(['skip', 'create'] as const).map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-decision`}
              value={value}
              checked={decision === value}
              onChange={() => {
                setDecision(value);
              }}
            />
            {value === 'skip'
              ? 'Skip this row (it is the same client)'
              : 'Create a new client anyway'}
          </label>
        ))}
      </fieldset>
      <Field data-invalid={reasonError !== null}>
        <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={IMPORT_LIMITS.overrideReasonMax}
          aria-invalid={reasonError !== null}
          aria-describedby={reasonError === null ? undefined : `${id}-reason-error`}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        <FieldError id={`${id}-reason-error`}>{reasonError}</FieldError>
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={working} onClick={onClose}>
          Cancel
        </AlertDialogCancel>
        <Button type="button" disabled={working} aria-busy={working} onClick={() => void submit()}>
          {working && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Save decision
        </Button>
      </AlertDialogFooter>
    </>
  );
}

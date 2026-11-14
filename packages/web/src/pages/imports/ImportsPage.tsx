import { useCallback, useEffect, useId, useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Download, FileUp, LoaderCircle } from 'lucide-react';
import {
  IMPORT_LIMITS,
  type ImportBatch,
  type ImportReconciliation,
  type ImportTemplate,
  type ImportTemplateId,
} from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import {
  getImportReconciliation,
  importTemplateUrl,
  listImportBatches,
  listImportTemplates,
  rememberImportFile,
  startDryRun,
} from '../../import-api.js';
import { importBatchPath } from '../../routes.js';
import { money } from '../billing/billing-format.js';
import { formatDateTime } from '../cases/case-format.js';
import { toErrorNotice } from '../error-notice.js';
import {
  KIND_LABELS,
  STATUS_BADGE,
  STATUS_LABELS,
  formatBytes,
  readFileText,
} from './import-format.js';

/**
 * Data import (TD-701–TD-706), administrators only: download a versioned
 * template, run a dry run on a CSV file, follow earlier batches, and compare
 * the migration totals against the source data.
 */
export function ImportsPage() {
  const headingId = useId();
  const [templates, setTemplates] = useState<readonly ImportTemplate[] | null>(null);
  const [batches, setBatches] = useState<readonly ImportBatch[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<ImportReconciliation | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [templateList, batchList, totals] = await Promise.all([
        listImportTemplates(signal),
        listImportBatches(null, signal),
        getImportReconciliation(signal),
      ]);
      setTemplates(templateList.templates);
      setBatches(batchList.batches);
      setNextCursor(batchList.nextCursor);
      setReconciliation(totals);
    } catch (error) {
      if (signal?.aborted !== true) {
        setNotice(toErrorNotice(error, 'Could not load data import'));
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

  async function loadMore(): Promise<void> {
    try {
      const page = await listImportBatches(nextCursor);
      setBatches((current) => [...(current ?? []), ...page.batches]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more batches'));
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Data import"
        description="Bring existing clients, active cases, and opening balances into TaxDesk. Every file is validated in a dry run first; nothing is written until you commit."
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {templates === null && notice === null ? (
        <LoadingMessage>Loading data import…</LoadingMessage>
      ) : (
        <div className="space-y-6">
          {templates !== null && <NewImportCard templates={templates} />}
          {templates !== null && <TemplatesCard templates={templates} />}
          <BatchesCard batches={batches} nextCursor={nextCursor} onMore={loadMore} />
          {reconciliation !== null && <ReconciliationCard totals={reconciliation} />}
        </div>
      )}
    </section>
  );
}

function NewImportCard({ templates }: { templates: readonly ImportTemplate[] }) {
  const id = useId();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<ImportTemplateId>(templates[0]?.id ?? 'clients.v1');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setNotice(null);
    if (file === null) {
      setFileError('Choose a CSV file.');
      return;
    }
    if (file.size === 0) {
      setFileError('The file is empty.');
      return;
    }
    if (file.size > IMPORT_LIMITS.maxFileBytes) {
      setFileError(
        `The file is larger than ${formatBytes(IMPORT_LIMITS.maxFileBytes)}. Split it into smaller files.`,
      );
      return;
    }
    setFileError(null);
    setBusy(true);
    try {
      const content = await readFileText(file);
      const batch = await startDryRun({ template, fileName: file.name, content });
      rememberImportFile(batch.id, content);
      void navigate(importBatchPath(batch.id));
    } catch (error) {
      setNotice(toErrorNotice(error, 'The dry run could not start'));
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">New dry run</h2>
        </CardTitle>
        <CardDescription>
          The dry run checks every row and shows what would be created, updated, or skipped. It
          changes no records.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {notice !== null && <ErrorAlert notice={notice} />}
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <Field>
            <FieldLabel htmlFor={`${id}-template`}>Template</FieldLabel>
            <NativeSelect
              id={`${id}-template`}
              value={template}
              onChange={(event) => {
                setTemplate(event.target.value as ImportTemplateId);
              }}
            >
              {templates.map((option) => (
                <NativeSelectOption key={option.id} value={option.id}>
                  {option.title} ({option.id})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field data-invalid={fileError !== null}>
            <FieldLabel htmlFor={`${id}-file`}>CSV file</FieldLabel>
            <Input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              aria-invalid={fileError !== null}
              aria-describedby={`${id}-file-help${fileError === null ? '' : ` ${id}-file-error`}`}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setFileError(null);
              }}
            />
            <FieldDescription id={`${id}-file-help`}>
              UTF-8 CSV with the template’s header row, up to{' '}
              {formatBytes(IMPORT_LIMITS.maxFileBytes)} and {IMPORT_LIMITS.maxRows.toLocaleString()}{' '}
              rows.
            </FieldDescription>
            <FieldError id={`${id}-file-error`}>{fileError}</FieldError>
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <FileUp aria-hidden="true" />
              )}
              {busy ? 'Checking the file…' : 'Run dry run'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TemplatesCard({ templates }: { templates: readonly ImportTemplate[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Templates</h2>
        </CardTitle>
        <CardDescription>
          Import clients first, then active cases, then opening balances: later files refer to
          earlier ones by external reference or record code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {templates.map((template) => (
          <section
            key={template.id}
            aria-labelledby={`template-${template.id}`}
            className="space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`template-${template.id}`} className="text-sm font-semibold">
                {template.title}{' '}
                <span className="font-normal text-muted-foreground">v{template.version}</span>
              </h3>
              <a
                href={importTemplateUrl(template.id)}
                download
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <Download aria-hidden="true" />
                Download {template.title.toLowerCase()} template
              </a>
            </div>
            <p className="text-sm text-muted-foreground">{template.description}</p>
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Columns and formats</summary>
              <Table>
                <TableCaption className="sr-only">{template.title} template columns</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Column</TableHead>
                    <TableHead scope="col">Required</TableHead>
                    <TableHead scope="col">Format</TableHead>
                    <TableHead scope="col">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {template.columns.map((column) => (
                    <TableRow key={column.name}>
                      <TableCell>
                        <code>{column.name}</code>
                      </TableCell>
                      <TableCell>
                        {column.required === 'always'
                          ? 'Yes'
                          : column.required === 'conditional'
                            ? 'Sometimes'
                            : 'No'}
                      </TableCell>
                      <TableCell className="whitespace-normal">{column.format}</TableCell>
                      <TableCell className="whitespace-normal">{column.description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

function BatchesCard({
  batches,
  nextCursor,
  onMore,
}: {
  batches: readonly ImportBatch[] | null;
  nextCursor: string | null;
  onMore: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Import batches</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {batches === null ? null : batches.length === 0 ? (
          <EmptyState title="No imports yet">Run a dry run to start.</EmptyState>
        ) : (
          <Table>
            <TableCaption className="sr-only">Import batches, newest first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Batch</TableHead>
                <TableHead scope="col">Template</TableHead>
                <TableHead scope="col">File</TableHead>
                <TableHead scope="col">Rows</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Validated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((batch) => (
                <TableRow key={batch.id}>
                  <TableCell>
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      to={importBatchPath(batch.id)}
                    >
                      {batch.batchCode}
                    </Link>
                  </TableCell>
                  <TableCell>{KIND_LABELS[batch.kind]}</TableCell>
                  <TableCell className="max-w-48 truncate">{batch.fileName}</TableCell>
                  <TableCell>{batch.rowCount}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[batch.status]}>
                      {STATUS_LABELS[batch.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDateTime(batch.validatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {nextCursor !== null && (
          <Button variant="outline" className="mt-4" onClick={() => void onMore()}>
            Show more batches
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ReconciliationCard({ totals }: { totals: ImportReconciliation }) {
  const rows: [string, string][] = [
    [
      'Clients in TaxDesk (active)',
      `${String(totals.clients.total)} (${String(totals.clients.active)})`,
    ],
    ['Clients created by import', String(totals.clients.imported)],
    ['Active cases in TaxDesk', String(totals.cases.active)],
    [
      'Cases created by import (still active)',
      `${String(totals.cases.imported)} (${String(totals.cases.importedStillActive)})`,
    ],
    ['Opening-balance invoices', String(totals.openingBalances.invoices)],
    ['Opening balances invoiced', money(totals.openingBalances.totalMinor)],
    ['Opening balances still outstanding', money(totals.openingBalances.outstandingMinor)],
    ['Committed batches', String(totals.batches.committed)],
    ['Rows that failed at commit', String(totals.batches.failedRows)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Migration reconciliation</h2>
        </CardTitle>
        <CardDescription>
          Compare these totals and the sampled records with the source data, then record the result
          in the migration rehearsal checklist.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-2 sm:grid-cols-2">
          {rows.map(([term, value]) => (
            <div key={term} className="flex justify-between gap-4 border-b py-1 text-sm">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {totals.samples.length > 0 && (
          <Table>
            <TableCaption>Random sample of imported rows to check against the source</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Batch</TableHead>
                <TableHead scope="col">Row</TableHead>
                <TableHead scope="col">External reference</TableHead>
                <TableHead scope="col">Record</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {totals.samples.map((sample) => (
                <TableRow key={`${sample.batchCode}-${String(sample.rowNumber)}`}>
                  <TableCell>{sample.batchCode}</TableCell>
                  <TableCell>{sample.rowNumber}</TableCell>
                  <TableCell>
                    <code>{sample.externalRef}</code>
                  </TableCell>
                  <TableCell>{sample.code}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

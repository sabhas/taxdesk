import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import {
  CheckCircle2,
  Download,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  DOCUMENT_ACCEPT_ATTRIBUTE,
  DOCUMENT_LIMITS,
  contentTypeForFileName,
  formatByteSize,
  unsafeFileNameReason,
  type CaseChecklistItem,
  type Document,
  type DocumentList,
  type DocumentReviewDecision,
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
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '../../api-client.js';
import {
  ChunkedUpload,
  UploadInterruptedError,
  type UploadProgress,
} from '../../chunked-upload.js';
import {
  deleteDocument,
  documentContentPath,
  httpUploadTransport,
  listDocuments,
  restoreDocument,
  reviewDocument,
  updateDocument,
  type UploadTransport,
} from '../../document-api.js';
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { casePath } from '../../routes.js';
import { toErrorNotice } from '../error-notice.js';
import { formatDateTime } from '../cases/case-format.js';
import { StorageStatusNotice } from './StorageStatusNotice.js';
import {
  PROVIDER_STATE_LABELS,
  VERIFICATION_BADGE,
  VERIFICATION_LABELS,
} from './document-format.js';

export type DocumentsScope =
  | {
      readonly kind: 'case';
      readonly clientId: string;
      readonly caseId: string;
      readonly checklist: readonly CaseChecklistItem[];
    }
  | { readonly kind: 'client'; readonly clientId: string };

export interface DocumentsPanelProps {
  readonly scope: DocumentsScope;
  /** Archived records are read-only: no upload affordance. */
  readonly readOnly?: boolean;
  /** Receives the loaded documents (e.g. for checklist counts). */
  readonly onDocumentsChange?: (documents: readonly Document[]) => void;
  /** Called after a change that may affect the parent record (checklist reopen). */
  readonly onChanged?: () => void;
  /** Injectable for tests. */
  readonly transport?: UploadTransport;
}

const PAGE_SIZE = 50;

/** Friendly copy for document conflicts and storage failures. */
function documentNotice(error: unknown, fallbackTitle: string): ErrorNotice {
  if (error instanceof ApiError) {
    if (error.code === 'PRECONDITION_FAILED' || error.status === 412) {
      return {
        title: 'This document changed',
        message:
          'Someone else changed this document while you were working. The list was refreshed; review it and try again.',
        requestId: error.requestId,
      };
    }
    if (error.status === 503) {
      return {
        title: 'Document storage is unavailable',
        message: error.message,
        requestId: error.requestId,
      };
    }
  }
  return toErrorNotice(error, fallbackTitle);
}

/** The document type a checklist item requires, or `null` when it has none. */
function requiredTypeFor(checklist: readonly CaseChecklistItem[], itemId: string): string | null {
  if (itemId.length === 0) return null;
  const type = checklist.find((entry) => entry.id === itemId)?.documentType ?? null;
  return type === null || type.trim().length === 0 ? null : type;
}

/** The API's field-level message when the type does not match the linked item. */
function linkInvalidMessage(error: unknown): string | null {
  return error instanceof ApiError && error.code === 'DOCUMENT_LINK_INVALID' ? error.message : null;
}

const LOCKED_TYPE_HINT =
  'Set by the linked checklist item. Unlink the item to choose another type.';

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 412);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function UploadForm({
  scope,
  maxUploadBytes,
  transport,
  onUploaded,
  onClose,
}: {
  scope: DocumentsScope;
  maxUploadBytes: number;
  transport: UploadTransport;
  onUploaded: (document: Document) => void;
  onClose: () => void;
}) {
  const id = useId();
  const checklist = scope.kind === 'case' ? scope.checklist : [];
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [itemId, setItemId] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [typeError, setTypeError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const uploadRef = useRef<ChunkedUpload | null>(null);

  useEffect(
    () => () => {
      // Leaving the dialog mid-upload pauses it; nothing is sent in the background.
      uploadRef.current?.pause();
    },
    [],
  );

  function chooseFile(next: File | null): void {
    setFile(next);
    setNotice(null);
    if (next === null) {
      setFileError(null);
      return;
    }
    const reason = unsafeFileNameReason(next.name);
    if (reason !== null) {
      setFileError(reason);
    } else if (next.size === 0) {
      setFileError('The file is empty.');
    } else if (next.size > maxUploadBytes) {
      setFileError(`The file is larger than the ${formatByteSize(maxUploadBytes)} limit.`);
    } else {
      setFileError(null);
    }
  }

  const lockedType = requiredTypeFor(checklist, itemId);

  function chooseItem(value: string): void {
    setItemId(value);
    const required = requiredTypeFor(checklist, value);
    if (required !== null) {
      // The API requires a linked document to have the item's type.
      setDocumentType(required);
      setTypeError(null);
    }
  }

  async function run(upload: ChunkedUpload): Promise<void> {
    setNotice(null);
    try {
      const document = await upload.start();
      onUploaded(document);
    } catch (error) {
      if (error instanceof UploadInterruptedError) return;
      const linkMessage = linkInvalidMessage(error);
      if (linkMessage !== null) {
        // Nothing was stored; let the user fix the type and try again.
        uploadRef.current = null;
        setProgress(null);
        setTypeError(linkMessage);
        return;
      }
      setNotice(documentNotice(error, 'The upload stopped'));
    }
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const type = documentType.trim();
    const contentType = file === null ? null : contentTypeForFileName(file.name);
    if (file === null) {
      setFileError('Choose a file to upload.');
    }
    if (type.length === 0) {
      setTypeError('Enter the document type.');
    }
    if (file === null || fileError !== null || type.length === 0 || contentType === null) {
      return;
    }
    const upload = new ChunkedUpload(
      file,
      {
        clientId: scope.clientId,
        caseId: scope.kind === 'case' ? scope.caseId : null,
        checklistItemId: itemId.length === 0 ? null : itemId,
        documentType: type,
        fileName: file.name,
        contentType,
        sizeBytes: file.size,
      },
      { transport, onProgress: setProgress },
    );
    uploadRef.current = upload;
    void run(upload);
  }

  const phase = progress?.phase ?? 'idle';
  const active =
    phase === 'starting' || phase === 'uploading' || phase === 'retrying' || phase === 'completing';
  const started = progress !== null && phase !== 'idle';
  const percent =
    progress === null || progress.totalBytes === 0
      ? 0
      : Math.floor((progress.uploadedBytes / progress.totalBytes) * 100);
  const statusText =
    progress === null
      ? ''
      : phase === 'retrying'
        ? `Connection problem — retrying (attempt ${String(progress.attempt)})…`
        : phase === 'completing'
          ? 'Checking the stored file…'
          : phase === 'paused'
            ? `Paused at ${String(percent)}%.`
            : phase === 'failed'
              ? `Stopped at ${String(percent)}%.`
              : phase === 'cancelled'
                ? 'Upload cancelled.'
                : phase === 'done'
                  ? 'Upload complete.'
                  : `Uploaded ${formatByteSize(progress.uploadedBytes)} of ${formatByteSize(progress.totalBytes)} (${String(percent)}%).`;

  return (
    <form noValidate onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Upload document</SheetTitle>
        <SheetDescription>
          PDF, JPEG, PNG, DOCX, XLSX, or CSV up to {formatByteSize(maxUploadBytes)}. Large files
          upload in {formatByteSize(DOCUMENT_LIMITS.chunkBytes)} parts and resume after a dropped
          connection.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto px-4">
        {notice !== null && <ErrorAlert notice={notice} />}
        <Field data-invalid={fileError !== null}>
          <FieldLabel htmlFor={`${id}-file`}>File</FieldLabel>
          <Input
            id={`${id}-file`}
            type="file"
            accept={DOCUMENT_ACCEPT_ATTRIBUTE}
            disabled={started}
            aria-invalid={fileError !== null}
            aria-describedby={fileError === null ? undefined : `${id}-file-error`}
            onChange={(event) => {
              chooseFile(event.target.files?.[0] ?? null);
            }}
          />
          {fileError !== null && <FieldError id={`${id}-file-error`}>{fileError}</FieldError>}
        </Field>
        {scope.kind === 'case' && (
          <Field>
            <FieldLabel htmlFor={`${id}-item`}>Checklist item</FieldLabel>
            <NativeSelect
              id={`${id}-item`}
              className="w-full"
              value={itemId}
              disabled={started}
              onChange={(event) => {
                chooseItem(event.target.value);
              }}
            >
              <NativeSelectOption value="">Not linked to a checklist item</NativeSelectOption>
              {checklist.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field data-invalid={typeError !== null}>
          <FieldLabel htmlFor={`${id}-type`}>Document type</FieldLabel>
          <Input
            id={`${id}-type`}
            value={documentType}
            maxLength={DOCUMENT_LIMITS.documentTypeMax}
            disabled={started}
            readOnly={lockedType !== null}
            aria-invalid={typeError !== null}
            aria-describedby={
              [
                lockedType === null ? null : `${id}-type-hint`,
                typeError === null ? null : `${id}-type-error`,
              ]
                .filter((entry) => entry !== null)
                .join(' ') || undefined
            }
            onChange={(event) => {
              setDocumentType(event.target.value);
              setTypeError(null);
            }}
          />
          {lockedType !== null && (
            <p id={`${id}-type-hint`} className="text-xs text-muted-foreground">
              {LOCKED_TYPE_HINT}
            </p>
          )}
          {typeError !== null && <FieldError id={`${id}-type-error`}>{typeError}</FieldError>}
        </Field>
        {started && (
          <div className="space-y-2">
            <div
              role="progressbar"
              aria-label={`Upload progress for ${file?.name ?? 'the file'}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${String(percent)}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {statusText}
            </p>
          </div>
        )}
      </div>
      <SheetFooter className="flex-row flex-wrap justify-end">
        {!started && (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              <Upload aria-hidden="true" />
              Upload
            </Button>
          </>
        )}
        {active && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                uploadRef.current?.pause();
              }}
            >
              <Pause aria-hidden="true" />
              Pause
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void uploadRef.current?.cancel().catch(() => undefined);
              }}
            >
              Cancel upload
            </Button>
          </>
        )}
        {(phase === 'paused' || phase === 'failed') && (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const upload = uploadRef.current;
                if (upload === null) return;
                void upload.cancel().catch(() => undefined);
                onClose();
              }}
            >
              Discard upload
            </Button>
            <Button
              type="button"
              onClick={() => {
                const upload = uploadRef.current;
                if (upload !== null) void run(upload);
              }}
            >
              {phase === 'paused' ? <Play aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
              {phase === 'paused' ? 'Resume' : 'Retry'}
            </Button>
          </>
        )}
        {phase === 'cancelled' && (
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        )}
      </SheetFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Edit metadata
// ---------------------------------------------------------------------------

function EditForm({
  document,
  checklist,
  onSaved,
  onConflict,
  onClose,
}: {
  document: Document;
  checklist: readonly CaseChecklistItem[];
  onSaved: (document: Document) => void;
  onConflict: (error: unknown) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [documentType, setDocumentType] = useState(document.documentType);
  const [itemId, setItemId] = useState(document.checklistItemId ?? '');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);
  const lockedType = requiredTypeFor(checklist, itemId);

  function chooseItem(value: string): void {
    setItemId(value);
    const required = requiredTypeFor(checklist, value);
    if (required !== null) {
      setDocumentType(required);
      setTypeError(null);
    }
  }

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const type = documentType.trim();
    if (type.length === 0) {
      setNotice({ title: 'Check the form', message: 'Enter the document type.' });
      return;
    }
    const changes: { documentType?: string; checklistItemId?: string | null } = {};
    if (type !== document.documentType) changes.documentType = type;
    const nextItem = itemId.length === 0 ? null : itemId;
    if (document.caseId !== null && nextItem !== document.checklistItemId) {
      changes.checklistItemId = nextItem;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setNotice(null);
    setTypeError(null);
    try {
      onSaved(await updateDocument(document.id, changes, document.version));
    } catch (error) {
      const linkMessage = linkInvalidMessage(error);
      if (linkMessage !== null) {
        setTypeError(linkMessage);
      } else if (isConflict(error)) {
        onConflict(error);
      } else {
        setNotice(documentNotice(error, 'Could not save the document'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Edit {document.fileName}</SheetTitle>
        <SheetDescription>Change how this document is classified.</SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto px-4">
        {notice !== null && <ErrorAlert notice={notice} />}
        <Field data-invalid={typeError !== null}>
          <FieldLabel htmlFor={`${id}-type`}>Document type</FieldLabel>
          <Input
            id={`${id}-type`}
            value={documentType}
            maxLength={DOCUMENT_LIMITS.documentTypeMax}
            readOnly={lockedType !== null}
            aria-invalid={typeError !== null}
            aria-describedby={
              [
                lockedType === null ? null : `${id}-type-hint`,
                typeError === null ? null : `${id}-type-error`,
              ]
                .filter((entry) => entry !== null)
                .join(' ') || undefined
            }
            onChange={(event) => {
              setDocumentType(event.target.value);
              setTypeError(null);
            }}
          />
          {lockedType !== null && (
            <p id={`${id}-type-hint`} className="text-xs text-muted-foreground">
              {LOCKED_TYPE_HINT}
            </p>
          )}
          {typeError !== null && <FieldError id={`${id}-type-error`}>{typeError}</FieldError>}
        </Field>
        {document.caseId !== null && (
          <Field>
            <FieldLabel htmlFor={`${id}-item`}>Checklist item</FieldLabel>
            <NativeSelect
              id={`${id}-item`}
              className="w-full"
              value={itemId}
              onChange={(event) => {
                chooseItem(event.target.value);
              }}
            >
              <NativeSelectOption value="">Not linked to a checklist item</NativeSelectOption>
              {checklist.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Save
        </Button>
      </SheetFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type Pending =
  | { kind: 'review'; document: Document; decision: DocumentReviewDecision }
  | { kind: 'delete'; document: Document }
  | { kind: 'restore'; document: Document };

const REVIEW_COPY: Readonly<
  Record<DocumentReviewDecision, { verb: string; title: string; description: string }>
> = {
  verified: {
    verb: 'Verify',
    title: 'Verify document',
    description: 'Confirm this is the right document and it is legible and complete.',
  },
  rejected: {
    verb: 'Reject',
    title: 'Reject document',
    description: 'Explain what is wrong so a replacement can be uploaded.',
  },
  pending: {
    verb: 'Reset review',
    title: 'Reset review',
    description: 'The document returns to "Awaiting review".',
  },
};

/**
 * Documents for a case or client (TD-406–TD-409): upload with resumable
 * progress, open, classify, verify/reject, delete, and restore. Every action
 * is gated by the per-document `permissions` the API returns.
 */
export function DocumentsPanel({
  scope,
  readOnly = false,
  onDocumentsChange,
  onChanged,
  transport = httpUploadTransport,
}: DocumentsPanelProps) {
  const id = useId();
  const [list, setList] = useState<DocumentList | null>(null);
  const [documents, setDocuments] = useState<readonly Document[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Document | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const caseId = scope.kind === 'case' ? scope.caseId : undefined;
  const clientId = scope.clientId;
  const checklist = scope.kind === 'case' ? scope.checklist : [];

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const page = await listDocuments(
          {
            ...(caseId === undefined ? { clientId } : { caseId }),
            state: showDeleted ? 'all' : 'active',
            limit: PAGE_SIZE,
          },
          signal,
        );
        setList(page);
        setDocuments(page.documents);
        setLoadFailed(false);
      } catch (error) {
        if (signal?.aborted !== true) {
          setList(null);
          setDocuments([]);
          setNotice(documentNotice(error, 'Could not load documents'));
          setLoadFailed(true);
        }
      }
    },
    [caseId, clientId, showDeleted],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    onDocumentsChange?.(documents);
  }, [documents, onDocumentsChange]);

  function replace(updated: Document): void {
    setDocuments((current) =>
      current
        .map((entry) => (entry.id === updated.id ? updated : entry))
        .filter((entry) => showDeleted || entry.deletedAt === null),
    );
  }

  async function refreshAfterConflict(error: unknown): Promise<void> {
    setNotice(documentNotice(error, 'The document could not be changed'));
    await load();
  }

  async function loadMore(): Promise<void> {
    if (list?.nextCursor == null) return;
    setLoadingMore(true);
    try {
      const page = await listDocuments({
        ...(caseId === undefined ? { clientId } : { caseId }),
        state: showDeleted ? 'all' : 'active',
        limit: PAGE_SIZE,
        cursor: list.nextCursor,
      });
      setList(page);
      setDocuments((current) => [...current, ...page.documents]);
    } catch (error) {
      setNotice(documentNotice(error, 'Could not load more documents'));
    } finally {
      setLoadingMore(false);
    }
  }

  function openAction(action: Pending): void {
    setPending(action);
    setNote('');
    setNoteError(null);
  }

  async function confirm(): Promise<void> {
    if (pending === null) return;
    const { document } = pending;
    if (pending.kind === 'review' && pending.decision === 'rejected' && note.trim().length === 0) {
      setNoteError('Explain why the document is rejected.');
      return;
    }
    setWorking(true);
    setNotice(null);
    setSuccess(null);
    try {
      if (pending.kind === 'review') {
        const trimmed = note.trim();
        replace(
          await reviewDocument(
            document.id,
            {
              decision: pending.decision,
              ...(trimmed.length === 0 ? {} : { note: trimmed }),
            },
            document.version,
          ),
        );
        setSuccess(
          pending.decision === 'verified'
            ? `${document.fileName} was verified.`
            : pending.decision === 'rejected'
              ? `${document.fileName} was rejected.`
              : `${document.fileName} is awaiting review again.`,
        );
      } else if (pending.kind === 'delete') {
        replace(await deleteDocument(document.id, document.version));
        setSuccess(`${document.fileName} was deleted. A manager can restore it.`);
      } else {
        replace(await restoreDocument(document.id, document.version));
        setSuccess(`${document.fileName} was restored.`);
      }
      setPending(null);
      onChanged?.();
    } catch (error) {
      setPending(null);
      if (isConflict(error) && !(error instanceof ApiError && error.code.startsWith('DOCUMENT_'))) {
        await refreshAfterConflict(error);
      } else {
        setNotice(documentNotice(error, 'The document could not be changed'));
      }
    } finally {
      setWorking(false);
    }
  }

  const storageAvailable = list?.storageAvailable ?? true;
  const canUpload = !readOnly && list?.permissions.upload === true;
  const dialog =
    pending === null
      ? null
      : pending.kind === 'review'
        ? {
            ...REVIEW_COPY[pending.decision],
            confirm: REVIEW_COPY[pending.decision].verb,
            showNote: pending.decision !== 'pending',
            noteLabel: pending.decision === 'rejected' ? 'Reason (required)' : 'Note (optional)',
            destructive: pending.decision === 'rejected',
          }
        : pending.kind === 'delete'
          ? {
              title: `Delete ${pending.document.fileName}?`,
              description:
                'The file moves to the storage recycle bin and is hidden from lists. A manager can restore it while the storage provider still has it.',
              confirm: 'Delete document',
              showNote: false,
              noteLabel: '',
              destructive: true,
            }
          : {
              title: `Restore ${pending.document.fileName}?`,
              description: 'The file is recovered from the storage recycle bin and shown again.',
              confirm: 'Restore document',
              showNote: false,
              noteLabel: '',
              destructive: false,
            };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>
          <h2 id={`${id}-heading`} className="text-base font-semibold">
            Documents
          </h2>
        </CardTitle>
        {canUpload && (
          <Button
            type="button"
            size="sm"
            disabled={!storageAvailable}
            onClick={() => {
              setNotice(null);
              setSuccess(null);
              setUploading(true);
            }}
          >
            <Upload aria-hidden="true" />
            Upload document
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {list !== null && !storageAvailable && <StorageStatusNotice />}
        {notice !== null && <ErrorAlert notice={notice} />}
        {success !== null && <SuccessNotice>{success}</SuccessNotice>}
        <label className="mb-3 flex items-center gap-2 text-sm">
          <Checkbox
            checked={showDeleted}
            onCheckedChange={(checked) => {
              setShowDeleted(checked);
            }}
          />
          Show deleted documents
        </label>
        {list === null && !loadFailed ? (
          <LoadingMessage>Loading documents…</LoadingMessage>
        ) : documents.length === 0 ? (
          list === null ? null : (
            <EmptyState title={showDeleted ? 'No documents' : 'No documents yet'}>
              {canUpload ? 'Upload the first document for this record.' : undefined}
            </EmptyState>
          )
        ) : (
          <ul aria-labelledby={`${id}-heading`} className="divide-y">
            {documents.map((document) => {
              const deleted = document.deletedAt !== null;
              const providerLabel = PROVIDER_STATE_LABELS[document.providerState];
              const showProviderBadge =
                providerLabel !== null && document.verificationState !== 'missing_provider';
              const reviewDecisions: DocumentReviewDecision[] = [];
              if (document.permissions.review && !deleted) {
                if (document.verificationState === 'pending') {
                  reviewDecisions.push('verified', 'rejected');
                } else if (
                  document.verificationState === 'verified' ||
                  document.verificationState === 'rejected'
                ) {
                  reviewDecisions.push('pending');
                }
              }
              return (
                <li key={document.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="break-all">{document.fileName}</span>
                        <Badge variant={VERIFICATION_BADGE[document.verificationState]}>
                          {VERIFICATION_LABELS[document.verificationState]}
                        </Badge>
                        {showProviderBadge && <Badge variant="warning">{providerLabel}</Badge>}
                        {deleted && <Badge variant="secondary">Deleted</Badge>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {document.documentType} · {formatByteSize(document.sizeBytes)}
                        {scope.kind === 'client' &&
                          document.caseId !== null &&
                          document.caseCode !== null && (
                            <>
                              {' · '}
                              <Link
                                to={casePath(document.caseId)}
                                className="font-mono text-primary underline-offset-4 hover:underline"
                              >
                                {document.caseCode}
                              </Link>
                            </>
                          )}
                        {document.checklistItemLabel !== null &&
                          ` · Checklist: ${document.checklistItemLabel}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Uploaded by {document.uploadedByName ?? 'a former user'} on{' '}
                        <time dateTime={document.uploadedAt}>
                          {formatDateTime(document.uploadedAt)}
                        </time>
                        {document.verifiedAt !== null &&
                          document.verifiedByName !== null &&
                          ` · Reviewed by ${document.verifiedByName} on ${formatDateTime(document.verifiedAt)}`}
                      </p>
                      {document.verificationNote !== null && (
                        <p
                          className={
                            document.verificationState === 'rejected'
                              ? 'text-sm text-destructive'
                              : 'text-sm'
                          }
                        >
                          Review note: {document.verificationNote}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {document.permissions.open &&
                        !deleted &&
                        (storageAvailable && document.providerState !== 'missing' ? (
                          <a
                            href={documentContentPath(document.id)}
                            className={buttonVariants({ size: 'sm', variant: 'outline' })}
                          >
                            <Download aria-hidden="true" />
                            Open
                            <span className="sr-only"> {document.fileName}</span>
                          </a>
                        ) : (
                          <Button type="button" size="sm" variant="outline" disabled>
                            <Download aria-hidden="true" />
                            Open
                            <span className="sr-only"> {document.fileName}</span>
                          </Button>
                        ))}
                      {reviewDecisions.map((decision) => (
                        <Button
                          key={decision}
                          type="button"
                          size="sm"
                          variant={decision === 'verified' ? 'default' : 'outline'}
                          disabled={working}
                          onClick={() => {
                            openAction({ kind: 'review', document, decision });
                          }}
                        >
                          {decision === 'verified' ? (
                            <CheckCircle2 aria-hidden="true" />
                          ) : decision === 'rejected' ? (
                            <XCircle aria-hidden="true" />
                          ) : (
                            <RotateCcw aria-hidden="true" />
                          )}
                          {REVIEW_COPY[decision].verb}
                          <span className="sr-only"> {document.fileName}</span>
                        </Button>
                      ))}
                      {document.permissions.edit && !deleted && !readOnly && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={working}
                          onClick={() => {
                            setEditing(document);
                          }}
                        >
                          <Pencil aria-hidden="true" />
                          Edit
                          <span className="sr-only"> {document.fileName}</span>
                        </Button>
                      )}
                      {document.permissions.delete && !deleted && !readOnly && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={working || !storageAvailable}
                          onClick={() => {
                            openAction({ kind: 'delete', document });
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          Delete
                          <span className="sr-only"> {document.fileName}</span>
                        </Button>
                      )}
                      {document.permissions.restore && deleted && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={working || !storageAvailable}
                          onClick={() => {
                            openAction({ kind: 'restore', document });
                          }}
                        >
                          <RotateCcw aria-hidden="true" />
                          Restore
                          <span className="sr-only"> {document.fileName}</span>
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {list?.nextCursor != null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            Show more documents
          </Button>
        )}
      </CardContent>

      <Sheet
        open={uploading}
        onOpenChange={(open) => {
          setUploading(open);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {uploading && list !== null && (
            <UploadForm
              scope={scope}
              maxUploadBytes={list.maxUploadBytes}
              transport={transport}
              onUploaded={(document) => {
                setUploading(false);
                setSuccess(`${document.fileName} was uploaded and is awaiting review.`);
                void load();
                onChanged?.();
              }}
              onClose={() => {
                setUploading(false);
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {editing !== null && (
            <EditForm
              document={editing}
              checklist={checklist}
              onSaved={(updated) => {
                replace(updated);
                setEditing(null);
                setSuccess(`${updated.fileName} was updated.`);
                onChanged?.();
              }}
              onConflict={(error) => {
                setEditing(null);
                void refreshAfterConflict(error);
              }}
              onClose={() => {
                setEditing(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !working) setPending(null);
        }}
      >
        {dialog !== null && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
              <AlertDialogDescription>{dialog.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {dialog.showNote && (
              <Field data-invalid={noteError !== null}>
                <FieldLabel htmlFor={`${id}-note`}>{dialog.noteLabel}</FieldLabel>
                <Textarea
                  id={`${id}-note`}
                  value={note}
                  maxLength={DOCUMENT_LIMITS.noteMax}
                  aria-invalid={noteError !== null}
                  aria-describedby={noteError === null ? undefined : `${id}-note-error`}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setNoteError(null);
                  }}
                />
                {noteError !== null && <FieldError id={`${id}-note-error`}>{noteError}</FieldError>}
              </Field>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                variant={dialog.destructive ? 'destructive' : 'default'}
                disabled={working}
                aria-busy={working}
                onClick={() => void confirm()}
              >
                {working && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                {dialog.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </Card>
  );
}

/** Verified, non-deleted documents per checklist item (case detail badges). */
export function verifiedCountsByItem(documents: readonly Document[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    if (
      document.checklistItemId !== null &&
      document.deletedAt === null &&
      document.verificationState === 'verified'
    ) {
      counts.set(document.checklistItemId, (counts.get(document.checklistItemId) ?? 0) + 1);
    }
  }
  return counts;
}

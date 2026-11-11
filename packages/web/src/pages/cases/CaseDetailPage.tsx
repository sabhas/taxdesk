import { useCallback, useEffect, useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { Archive, ArrowRight, LoaderCircle, Pencil } from 'lucide-react';
import {
  FIRM_CURRENCY,
  formatMinorAmount,
  type CaseActivity,
  type CaseAvailableTransition,
  type CaseChecklistItem,
  type CasePerson,
  type CaseStatusHistoryEntry,
  type ChecklistAction,
  type TaxCase,
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
import { DocumentTitle } from '@/lib/document-title';
import { ApiError } from '../../api-client.js';
import {
  archiveCase,
  checklistAction,
  getCase,
  getCaseStatusHistory,
  listCaseActivity,
  listCaseAssignees,
  transitionCase,
  updateCase,
} from '../../case-api.js';
import {
  EmptyState,
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS, clientPath } from '../../routes.js';
import { toErrorNotice } from '../error-notice.js';
import {
  CASE_ACTIVITY_LABELS,
  CASE_FIELD_LABELS,
  CHECKLIST_STATE_BADGE,
  CHECKLIST_STATE_LABELS,
  STATUS_KIND_BADGE,
  formatDate,
  formatDateTime,
  urgencyLabel,
} from './case-format.js';

const ACTIVITY_PAGE = 20;

const ACTION_COPY: Readonly<
  Record<ChecklistAction, { verb: string; title: string; description: string; required: boolean }>
> = {
  complete: {
    verb: 'Complete',
    title: 'Mark item complete',
    description: 'Add a note for the reviewer if useful.',
    required: false,
  },
  reopen: {
    verb: 'Reopen',
    title: 'Reopen item',
    description: 'The item returns to "To do" and any verification is cleared.',
    required: false,
  },
  verify: {
    verb: 'Verify',
    title: 'Verify item',
    description: 'Confirm the preparer’s work is correct.',
    required: false,
  },
  reject: {
    verb: 'Return',
    title: 'Return item to preparer',
    description: 'Explain what needs to change. The preparer sees this comment.',
    required: true,
  },
};

type PendingAction =
  | { kind: 'transition'; transition: CaseAvailableTransition }
  | { kind: 'checklist'; item: CaseChecklistItem; action: ChecklistAction }
  | { kind: 'archive' };

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <CardTitle>
      <h2 className="text-base font-semibold">{children}</h2>
    </CardTitle>
  );
}

function ActivityEntry({ event }: { event: CaseActivity }) {
  const details: string[] = [];
  if (event.fromStatus !== null && event.toStatus !== null) {
    details.push(`${event.fromStatus} → ${event.toStatus}`);
  } else if (event.toStatus !== null && event.action === 'case.created') {
    details.push(`Started at ${event.toStatus}`);
  }
  if (event.checklistItem !== null) details.push(event.checklistItem);
  if (event.changedFields.length > 0) {
    details.push(
      `Changed: ${event.changedFields.map((field) => CASE_FIELD_LABELS[field]).join(', ')}`,
    );
  }
  if (event.changedFields.includes('primaryConsultant')) {
    details.push(`Primary consultant: ${event.primaryConsultant?.displayName ?? 'unassigned'}`);
  }
  if (event.changedFields.includes('reviewer')) {
    details.push(`Reviewer: ${event.reviewer?.displayName ?? 'none'}`);
  }
  if (event.changedFields.includes('dueDate') && event.dueDate !== null) {
    details.push(`Due ${formatDate(event.dueDate)}`);
  }
  return (
    <li className="border-b py-3 last:border-b-0">
      <p className="text-sm">
        <span className="font-medium">{event.actor?.displayName ?? 'System'}</span>{' '}
        {CASE_ACTIVITY_LABELS[event.action].toLowerCase()}
      </p>
      <p className="text-xs text-muted-foreground">
        <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
      </p>
      {details.map((detail) => (
        <p key={detail} className="mt-1 text-sm text-muted-foreground">
          {detail}
        </p>
      ))}
      {event.overrideReason !== null && (
        <p className="mt-1 text-sm">
          <span className="text-muted-foreground">Reason:</span> {event.overrideReason}
        </p>
      )}
    </li>
  );
}

function ChecklistRow({
  item,
  taxCase,
  busy,
  onAction,
}: {
  item: CaseChecklistItem;
  taxCase: TaxCase;
  busy: boolean;
  onAction: (item: CaseChecklistItem, action: ChecklistAction) => void;
}) {
  const { prepareChecklist, reviewChecklist } = taxCase.allowedActions;
  const actions: ChecklistAction[] = [];
  if (prepareChecklist && (item.state === 'open' || item.state === 'rejected'))
    actions.push('complete');
  if (reviewChecklist && item.reviewRequired && item.state === 'completed') {
    actions.push('verify', 'reject');
  }
  if (prepareChecklist && (item.state === 'completed' || item.state === 'verified')) {
    actions.push('reopen');
  }
  return (
    <li className="border-b py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {item.label}
            <Badge variant={CHECKLIST_STATE_BADGE[item.state]}>
              {CHECKLIST_STATE_LABELS[item.state]}
            </Badge>
            {item.required ? (
              <Badge variant="outline">Required</Badge>
            ) : (
              <Badge variant="secondary">Optional</Badge>
            )}
            {item.reviewRequired && <Badge variant="outline">Needs review</Badge>}
          </p>
          {item.documentType !== null && (
            <p className="text-xs text-muted-foreground">Document: {item.documentType}</p>
          )}
          {item.instructions.length > 0 && (
            <p className="text-sm text-muted-foreground">{item.instructions}</p>
          )}
          {item.completedBy !== null && item.completedAt !== null && (
            <p className="text-xs text-muted-foreground">
              Completed by {item.completedBy.displayName} on {formatDateTime(item.completedAt)}
              {item.preparerComment.length > 0 && ` — “${item.preparerComment}”`}
            </p>
          )}
          {item.reviewedBy !== null && item.reviewedAt !== null && (
            <p className="text-xs text-muted-foreground">
              {item.state === 'rejected' ? 'Returned' : 'Verified'} by {item.reviewedBy.displayName}{' '}
              on {formatDateTime(item.reviewedAt)}
            </p>
          )}
          {item.reviewComment.length > 0 && (
            <p className={item.state === 'rejected' ? 'text-sm text-destructive' : 'text-sm'}>
              Reviewer: {item.reviewComment}
            </p>
          )}
        </div>
        {actions.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={action === 'reject' || action === 'reopen' ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => {
                  onAction(item, action);
                }}
              >
                {ACTION_COPY[action].verb}
                <span className="sr-only"> {item.label}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function EditDetailsForm({
  taxCase,
  onSaved,
  onCancel,
}: {
  taxCase: TaxCase;
  onSaved: (updated: TaxCase) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [people, setPeople] = useState<readonly CasePerson[]>([]);
  const [dueDate, setDueDate] = useState(taxCase.dueDate);
  const [notes, setNotes] = useState(taxCase.notes);
  const [consultant, setConsultant] = useState(taxCase.primaryConsultant?.id ?? '');
  const [reviewer, setReviewer] = useState(taxCase.reviewer?.id ?? '');
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const canAssign = taxCase.allowedActions.assign;

  useEffect(() => {
    const controller = new AbortController();
    listCaseAssignees(controller.signal)
      .then((result) => {
        setPeople(result.assignees);
      })
      .catch(() => {
        // Assignee lists fall back to the current assignees.
      });
    return () => {
      controller.abort();
    };
  }, []);

  const options = [
    ...people,
    ...[taxCase.primaryConsultant, taxCase.reviewer].filter(
      (person): person is CasePerson =>
        person !== null && !people.some((entry) => entry.id === person.id),
    ),
  ];

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    setFieldErrors({});
    try {
      const updated = await updateCase(
        taxCase.id,
        {
          dueDate,
          notes,
          primaryConsultantUserId: consultant.length === 0 ? null : consultant,
          reviewerUserId: reviewer.length === 0 ? null : reviewer,
        },
        taxCase.version,
      );
      onSaved(updated);
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(
          Object.fromEntries(error.fieldErrors.map((entry) => [entry.field, entry.message])),
        );
      }
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        setNotice({
          title: 'This case changed',
          message:
            'Someone else updated this case while you were editing. Close this panel to load the latest version; your unsaved values are still shown here so you can copy them.',
          requestId: error.requestId,
        });
      } else {
        setNotice(toErrorNotice(error, 'Could not save the case'));
      }
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (name: string) =>
    fieldErrors[name] === undefined ? null : (
      <FieldError id={`${id}-${name}-error`}>{fieldErrors[name]}</FieldError>
    );

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>Edit {taxCase.caseCode}</SheetTitle>
        <SheetDescription>
          Status changes go through the status actions, not this form.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto px-4">
        {notice !== null && <ErrorAlert notice={notice} />}
        <Field data-invalid={fieldErrors['dueDate'] !== undefined}>
          <FieldLabel htmlFor={`${id}-due`}>Due date</FieldLabel>
          <Input
            id={`${id}-due`}
            type="date"
            required
            value={dueDate}
            aria-invalid={fieldErrors['dueDate'] !== undefined}
            onChange={(event) => {
              setDueDate(event.target.value);
            }}
          />
          {fieldError('dueDate')}
        </Field>
        <Field data-invalid={fieldErrors['primaryConsultantUserId'] !== undefined}>
          <FieldLabel htmlFor={`${id}-consultant`}>Primary consultant</FieldLabel>
          <NativeSelect
            id={`${id}-consultant`}
            className="w-full"
            value={consultant}
            disabled={!canAssign}
            onChange={(event) => {
              setConsultant(event.target.value);
            }}
          >
            <NativeSelectOption value="">Unassigned</NativeSelectOption>
            {options.map((person) => (
              <NativeSelectOption key={person.id} value={person.id}>
                {person.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {fieldError('primaryConsultantUserId')}
        </Field>
        <Field data-invalid={fieldErrors['reviewerUserId'] !== undefined}>
          <FieldLabel htmlFor={`${id}-reviewer`}>Reviewer</FieldLabel>
          <NativeSelect
            id={`${id}-reviewer`}
            className="w-full"
            value={reviewer}
            disabled={!canAssign}
            onChange={(event) => {
              setReviewer(event.target.value);
            }}
          >
            <NativeSelectOption value="">No reviewer</NativeSelectOption>
            {options.map((person) => (
              <NativeSelectOption key={person.id} value={person.id}>
                {person.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {fieldError('reviewerUserId')}
        </Field>
        {!canAssign && (
          <p className="text-sm text-muted-foreground">Only a manager can change assignments.</p>
        )}
        <Field>
          <FieldLabel htmlFor={`${id}-notes`}>Notes</FieldLabel>
          <Textarea
            id={`${id}-notes`}
            value={notes}
            maxLength={4000}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </Field>
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Save changes
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * One tax case (TD-305–TD-309): summary, status actions, checklist work, the
 * immutable status history, and audit-safe activity. Every action is checked
 * again by the API; the buttons shown here follow the server's
 * `allowedActions`.
 */
export function CaseDetailPage() {
  const { caseId = '' } = useParams();
  const location = useLocation();
  const headingId = useId();
  const [taxCase, setTaxCase] = useState<TaxCase | null>(null);
  const [history, setHistory] = useState<readonly CaseStatusHistoryEntry[]>([]);
  const [activity, setActivity] = useState<readonly CaseActivity[]>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(
    typeof (location.state as { notice?: unknown } | null)?.notice === 'string'
      ? (location.state as { notice: string }).notice
      : null,
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [editing, setEditing] = useState(false);

  const loadSide = useCallback(
    async (signal?: AbortSignal) => {
      const [statusHistory, events] = await Promise.all([
        getCaseStatusHistory(caseId, signal),
        listCaseActivity(caseId, { limit: ACTIVITY_PAGE }, signal),
      ]);
      setHistory(statusHistory.entries);
      setActivity(events.events);
      setActivityCursor(events.nextCursor);
    },
    [caseId],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [record] = await Promise.all([getCase(caseId, signal), loadSide(signal)]);
        setTaxCase(record);
      } catch (error) {
        if (signal?.aborted !== true) {
          setNotice(toErrorNotice(error, 'Could not load this case'));
        }
      }
    },
    [caseId, loadSide],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  function open(action: PendingAction): void {
    setPending(action);
    setComment('');
    setCommentError(null);
  }

  async function confirm(): Promise<void> {
    if (taxCase === null || pending === null) return;
    if (
      pending.kind === 'checklist' &&
      ACTION_COPY[pending.action].required &&
      comment.trim().length === 0
    ) {
      setCommentError('Explain what needs to change.');
      return;
    }
    setWorking(true);
    setNotice(null);
    setSuccess(null);
    try {
      let updated: TaxCase;
      let message: string;
      if (pending.kind === 'transition') {
        updated = await transitionCase(
          taxCase.id,
          pending.transition.to.key,
          comment.trim(),
          taxCase.version,
        );
        message = `Status changed to ${updated.status.name}.`;
      } else if (pending.kind === 'checklist') {
        updated = await checklistAction(
          taxCase.id,
          pending.item.id,
          pending.action,
          comment.trim(),
          pending.item.version,
        );
        message = `${ACTION_COPY[pending.action].verb}: ${pending.item.label}.`;
      } else {
        updated = await archiveCase(taxCase.id, taxCase.version);
        message = 'Case archived. Its history is kept.';
      }
      setTaxCase(updated);
      setSuccess(message);
      setPending(null);
      await loadSide();
    } catch (error) {
      setPending(null);
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        setNotice({
          title: 'This case changed',
          message:
            'Someone else updated this case while you were viewing it. The latest version is shown below; review it and try again.',
          requestId: error.requestId,
        });
      } else {
        setNotice(toErrorNotice(error, 'Could not complete the action'));
      }
      await load();
    } finally {
      setWorking(false);
    }
  }

  async function loadMoreActivity(): Promise<void> {
    if (activityCursor === null) return;
    try {
      const events = await listCaseActivity(caseId, {
        limit: ACTIVITY_PAGE,
        cursor: activityCursor,
      });
      setActivity((current) => [...current, ...events.events]);
      setActivityCursor(events.nextCursor);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not load more activity'));
    }
  }

  if (taxCase === null) {
    return (
      <section aria-labelledby={headingId}>
        <DocumentTitle title="Case" />
        <PageHeader id={headingId} title="Case" />
        {notice === null ? (
          <LoadingMessage>Loading case…</LoadingMessage>
        ) : (
          <>
            <ErrorAlert notice={notice} />
            <Link to={ROUTE_PATHS.cases} className={buttonVariants({ variant: 'outline' })}>
              Back to cases
            </Link>
          </>
        )}
      </section>
    );
  }

  const progress = taxCase.checklistProgress;
  const archived = taxCase.state === 'archived';
  const urgency = urgencyLabel(taxCase.urgency);
  const dialog =
    pending === null
      ? null
      : pending.kind === 'transition'
        ? {
            title: `Move to ${pending.transition.to.name}?`,
            description: `From ${taxCase.status.name} to ${pending.transition.to.name}. The change is recorded permanently in the status history.`,
            label: 'Note (optional)',
            confirm: `Move to ${pending.transition.to.name}`,
            showComment: true,
          }
        : pending.kind === 'checklist'
          ? {
              title: `${ACTION_COPY[pending.action].title}: ${pending.item.label}`,
              description: ACTION_COPY[pending.action].description,
              label: ACTION_COPY[pending.action].required ? 'Comment' : 'Comment (optional)',
              confirm: ACTION_COPY[pending.action].verb,
              showComment: true,
            }
          : {
              title: `Archive ${taxCase.caseCode}?`,
              description:
                'The case leaves the work queues and becomes read-only. Its status history, checklist, and activity are kept.',
              label: '',
              confirm: 'Archive case',
              showComment: false,
            };

  return (
    <section aria-labelledby={headingId}>
      <DocumentTitle title={`${taxCase.caseCode} · ${taxCase.client.displayName}`} />
      <PageHeader
        id={headingId}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{taxCase.caseCode}</span>
            <Badge variant={STATUS_KIND_BADGE[taxCase.status.kind]}>{taxCase.status.name}</Badge>
            {archived && <Badge variant="secondary">Archived</Badge>}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link
              to={clientPath(taxCase.client.id)}
              className="text-primary underline-offset-4 hover:underline"
            >
              {taxCase.client.displayName}
            </Link>
            <span aria-hidden="true">·</span>
            <span>{taxCase.service.name}</span>
            <span aria-hidden="true">·</span>
            <span>Tax year {taxCase.taxYear}</span>
          </span>
        }
        actions={
          <>
            {taxCase.allowedActions.edit && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <Pencil aria-hidden="true" />
                Edit details
              </Button>
            )}
            {taxCase.allowedActions.archive && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  open({ kind: 'archive' });
                }}
              >
                <Archive aria-hidden="true" />
                Archive
              </Button>
            )}
          </>
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {archived && taxCase.archivedAt !== null && (
        <InfoNotice>
          Archived on {formatDateTime(taxCase.archivedAt)}. This case is read-only.
        </InfoNotice>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <SectionTitle>Status</SectionTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">
                Currently <strong>{taxCase.status.name}</strong>
              </p>
              {taxCase.availableTransitions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {archived
                    ? 'Archived cases cannot change status.'
                    : 'This status ends the workflow; no further moves are available.'}
                </p>
              ) : !taxCase.allowedActions.transition ? (
                <p className="text-sm text-muted-foreground">
                  Only assigned staff or a manager can move this case.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-2" aria-label="Move the case to">
                  {taxCase.availableTransitions.map((transition) => (
                    <li key={transition.to.key} className="space-y-1">
                      <Button
                        type="button"
                        variant={transition.to.kind === 'cancelled' ? 'outline' : 'default'}
                        disabled={transition.blockedReason !== null || working}
                        aria-describedby={
                          transition.blockedReason === null
                            ? undefined
                            : `${headingId}-blocked-${transition.to.key}`
                        }
                        onClick={() => {
                          open({ kind: 'transition', transition });
                        }}
                      >
                        <ArrowRight aria-hidden="true" />
                        {transition.to.name}
                      </Button>
                      {transition.blockedReason !== null && (
                        <p
                          id={`${headingId}-blocked-${transition.to.key}`}
                          className="max-w-56 text-xs text-muted-foreground"
                        >
                          {transition.blockedReason}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle>Checklist</SectionTitle>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {progress.required} required · {progress.completed} of {progress.total} completed ·{' '}
                {progress.verified} verified
                {progress.requiredOutstanding > 0
                  ? ` · ${String(progress.requiredOutstanding)} required still outstanding`
                  : ' · all required items done'}
              </p>
            </CardHeader>
            <CardContent>
              {taxCase.checklist.length === 0 ? (
                <EmptyState title="This workflow has no checklist" />
              ) : (
                <ol aria-label="Checklist items">
                  {taxCase.checklist.map((item) => (
                    <ChecklistRow
                      key={item.id}
                      item={item}
                      taxCase={taxCase}
                      busy={working}
                      onAction={(target, action) => {
                        open({ kind: 'checklist', item: target, action });
                      }}
                    />
                  ))}
                </ol>
              )}
              {!archived && taxCase.status.kind !== 'open' && (
                <p className="mt-3 text-sm text-muted-foreground">
                  The checklist is locked once a case is {taxCase.status.name.toLowerCase()}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle>Status history</SectionTitle>
            </CardHeader>
            <CardContent>
              <ol aria-label="Status history, oldest first" className="space-y-3">
                {history.map((entry) => (
                  <li key={entry.id} className="text-sm">
                    <p>
                      <span className="font-medium">
                        {entry.from === null
                          ? `Opened at ${entry.to.name}`
                          : `${entry.from.name} → ${entry.to.name}`}
                      </span>{' '}
                      <span className="text-muted-foreground">
                        by {entry.actor?.displayName ?? 'System'},{' '}
                        <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
                      </span>
                    </p>
                    {entry.note.length > 0 && (
                      <p className="text-muted-foreground">“{entry.note}”</p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <SectionTitle>Summary</SectionTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <Detail term="Due">
                  <time dateTime={taxCase.dueDate}>{formatDate(taxCase.dueDate)}</time>
                  {urgency !== null && (
                    <Badge
                      variant={taxCase.urgency === 'overdue' ? 'destructive' : 'warning'}
                      className="ml-2"
                    >
                      {urgency}
                    </Badge>
                  )}
                </Detail>
                <Detail term="Primary consultant">
                  {taxCase.primaryConsultant?.displayName ?? 'Unassigned'}
                </Detail>
                <Detail term="Reviewer">{taxCase.reviewer?.displayName ?? 'None'}</Detail>
                <Detail term="Fee">
                  {FIRM_CURRENCY} {formatMinorAmount(taxCase.service.feeMinor)}
                </Detail>
                <Detail term="Workflow">
                  {taxCase.workflow.templateName}, version {taxCase.workflow.versionNumber}
                </Detail>
                <Detail term="Opened">{formatDateTime(taxCase.createdAt)}</Detail>
                <Detail term="Notes">
                  {taxCase.notes.length === 0 ? (
                    <span className="text-muted-foreground">No notes.</span>
                  ) : (
                    <span className="whitespace-pre-wrap">{taxCase.notes}</span>
                  )}
                </Detail>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <SectionTitle>Activity</SectionTitle>
            </CardHeader>
            <CardContent>
              {activity.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <ol aria-label="Case activity, newest first">
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
                  onClick={() => void loadMoreActivity()}
                >
                  Show older activity
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next && !working) setPending(null);
        }}
      >
        {dialog !== null && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
              <AlertDialogDescription>{dialog.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {dialog.showComment && (
              <Field data-invalid={commentError !== null}>
                <FieldLabel htmlFor={`${headingId}-comment`}>{dialog.label}</FieldLabel>
                <Textarea
                  id={`${headingId}-comment`}
                  value={comment}
                  maxLength={1000}
                  aria-invalid={commentError !== null}
                  aria-describedby={
                    commentError === null ? undefined : `${headingId}-comment-error`
                  }
                  onChange={(event) => {
                    setComment(event.target.value);
                    setCommentError(null);
                  }}
                />
                <FieldError id={`${headingId}-comment-error`}>{commentError}</FieldError>
              </Field>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                type="button"
                disabled={working}
                aria-busy={working}
                variant={pending?.kind === 'archive' ? 'destructive' : 'default'}
                onClick={() => void confirm()}
              >
                {working && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                {dialog.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          {editing && (
            <EditDetailsForm
              taxCase={taxCase}
              onCancel={() => {
                setEditing(false);
                void load();
              }}
              onSaved={(updated) => {
                setEditing(false);
                setTaxCase(updated);
                setSuccess('Case details saved.');
                void loadSide();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

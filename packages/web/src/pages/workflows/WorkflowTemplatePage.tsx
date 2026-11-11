import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  LoaderCircle,
  Plus,
  Save,
  Send,
  Trash2,
} from 'lucide-react';
import {
  WORKFLOW_STATUS_KINDS,
  WorkflowDefinitionSchema,
  validateWorkflowDefinition,
  workflowKeyFrom,
  type WorkflowDefinition,
  type WorkflowStatusKind,
  type WorkflowTemplate,
  type WorkflowValidationIssue,
  type WorkflowVersion,
} from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { DocumentTitle } from '@/lib/document-title';
import { ApiError } from '../../api-client.js';
import {
  createWorkflowDraft,
  getWorkflowTemplate,
  getWorkflowVersion,
  publishWorkflowVersion,
  saveWorkflowDraft,
} from '../../case-api.js';
import {
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS } from '../../routes.js';
import { toErrorNotice } from '../error-notice.js';
import { STATUS_KIND_BADGE, STATUS_KIND_LABELS, formatDateTime } from '../cases/case-format.js';

function uniqueKey(base: string, taken: readonly string[]): string {
  let key = workflowKeyFrom(base);
  let suffix = 2;
  while (taken.includes(key)) {
    key = `${workflowKeyFrom(base).slice(0, 36)}_${String(suffix)}`;
    suffix += 1;
  }
  return key;
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** Structural (schema) and semantic issues, so the editor shows everything publishing checks. */
function issuesFor(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  const parsed = WorkflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
  }
  return validateWorkflowDefinition(parsed.data);
}

function DefinitionEditor({
  definition,
  onChange,
  readOnly,
}: {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
  readOnly: boolean;
}) {
  const id = useId();
  const statusKeys = definition.statuses.map((status) => status.key);
  const update = (patch: Partial<WorkflowDefinition>) => {
    onChange({ ...definition, ...patch });
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Statuses</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            In display order. Exactly one is the initial status. Filed and Completed statuses always
            require a complete, verified checklist.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {definition.statuses.map((status, index) => (
            <fieldset
              key={status.key}
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto_auto] sm:items-end"
            >
              <legend className="sr-only">Status {status.name}</legend>
              <div className="space-y-1">
                <Label htmlFor={`${id}-status-${status.key}`}>Name</Label>
                <Input
                  id={`${id}-status-${status.key}`}
                  value={status.name}
                  maxLength={60}
                  disabled={readOnly}
                  onChange={(event) => {
                    update({
                      statuses: definition.statuses.map((entry, at) =>
                        at === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    });
                  }}
                />
                <p className="font-mono text-xs text-muted-foreground">{status.key}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${id}-kind-${status.key}`}>Meaning</Label>
                <NativeSelect
                  id={`${id}-kind-${status.key}`}
                  className="w-full"
                  value={status.kind}
                  disabled={readOnly}
                  onChange={(event) => {
                    const kind = event.target.value as WorkflowStatusKind;
                    update({
                      statuses: definition.statuses.map((entry, at) =>
                        at === index
                          ? {
                              ...entry,
                              kind,
                              requiresChecklistComplete:
                                kind === 'filed' || kind === 'completed'
                                  ? true
                                  : entry.requiresChecklistComplete,
                            }
                          : entry,
                      ),
                    });
                  }}
                >
                  {WORKFLOW_STATUS_KINDS.map((kind) => (
                    <NativeSelectOption key={kind} value={kind}>
                      {STATUS_KIND_LABELS[kind]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-initial`}
                  className="size-4 accent-primary"
                  checked={status.initial}
                  disabled={readOnly}
                  onChange={() => {
                    update({
                      statuses: definition.statuses.map((entry, at) => ({
                        ...entry,
                        initial: at === index,
                      })),
                    });
                  }}
                />
                Initial
              </label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <Checkbox
                  checked={status.requiresChecklistComplete}
                  disabled={readOnly || status.kind === 'filed' || status.kind === 'completed'}
                  onCheckedChange={(checked) => {
                    update({
                      statuses: definition.statuses.map((entry, at) =>
                        at === index ? { ...entry, requiresChecklistComplete: checked } : entry,
                      ),
                    });
                  }}
                />
                Needs checklist
              </label>
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    update({
                      statuses: definition.statuses.filter((_, at) => at !== index),
                      transitions: definition.transitions.filter(
                        (transition) =>
                          transition.from !== status.key && transition.to !== status.key,
                      ),
                    });
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove<span className="sr-only"> {status.name}</span>
                </Button>
              )}
            </fieldset>
          ))}
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                update({
                  statuses: [
                    ...definition.statuses,
                    {
                      key: uniqueKey('New status', statusKeys),
                      name: 'New status',
                      kind: 'open',
                      initial: false,
                      requiresChecklistComplete: false,
                    },
                  ],
                });
              }}
            >
              <Plus aria-hidden="true" />
              Add status
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Allowed transitions</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            For each status, choose where a case may move next. Completed and cancelled statuses end
            the case.
          </p>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {definition.statuses.map((from) => (
            <fieldset key={from.key} className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">From {from.name}</legend>
              <div className="mt-1 grid gap-1">
                {definition.statuses
                  .filter((to) => to.key !== from.key)
                  .map((to) => {
                    const checked = definition.transitions.some(
                      (transition) => transition.from === from.key && transition.to === to.key,
                    );
                    return (
                      <label key={to.key} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          disabled={readOnly}
                          onCheckedChange={(next) => {
                            update({
                              transitions: next
                                ? [...definition.transitions, { from: from.key, to: to.key }]
                                : definition.transitions.filter(
                                    (transition) =>
                                      !(transition.from === from.key && transition.to === to.key),
                                  ),
                            });
                          }}
                        />
                        <span>
                          <span className="sr-only">From {from.name} to </span>
                          {to.name}
                        </span>
                      </label>
                    );
                  })}
              </div>
            </fieldset>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Checklist</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            In work order. The preparer completes each item; items that need review must also be
            verified by someone else.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {definition.checklist.length === 0 && (
            <p className="text-sm text-muted-foreground">No checklist items.</p>
          )}
          {definition.checklist.map((item, index) => {
            const setItem = (patch: Partial<typeof item>) => {
              update({
                checklist: definition.checklist.map((entry, at) =>
                  at === index ? { ...entry, ...patch } : entry,
                ),
              });
            };
            return (
              <fieldset key={item.key} className="space-y-3 rounded-lg border p-3">
                <legend className="sr-only">Checklist item {item.label}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-item-${item.key}`}>Item</Label>
                    <Input
                      id={`${id}-item-${item.key}`}
                      value={item.label}
                      maxLength={200}
                      disabled={readOnly}
                      onChange={(event) => {
                        setItem({ label: event.target.value });
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-doc-${item.key}`}>Document type</Label>
                    <Input
                      id={`${id}-doc-${item.key}`}
                      value={item.documentType ?? ''}
                      maxLength={80}
                      placeholder="None"
                      disabled={readOnly}
                      onChange={(event) => {
                        const value = event.target.value;
                        setItem({ documentType: value.trim().length === 0 ? null : value });
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-instructions-${item.key}`}>Instructions</Label>
                  <Textarea
                    id={`${id}-instructions-${item.key}`}
                    value={item.instructions}
                    maxLength={2000}
                    disabled={readOnly}
                    onChange={(event) => {
                      setItem({ instructions: event.target.value });
                    }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={item.required}
                      disabled={readOnly}
                      onCheckedChange={(checked) => {
                        setItem({ required: checked });
                      }}
                    />
                    Required
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={item.reviewRequired}
                      disabled={readOnly}
                      onCheckedChange={(checked) => {
                        setItem({ reviewRequired: checked });
                      }}
                    />
                    Reviewer must verify
                  </label>
                  {!readOnly && (
                    <div className="ml-auto flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={index === 0}
                        onClick={() => {
                          update({ checklist: move(definition.checklist, index, index - 1) });
                        }}
                      >
                        <ArrowUp aria-hidden="true" />
                        <span className="sr-only">Move {item.label} up</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={index === definition.checklist.length - 1}
                        onClick={() => {
                          update({ checklist: move(definition.checklist, index, index + 1) });
                        }}
                      >
                        <ArrowDown aria-hidden="true" />
                        <span className="sr-only">Move {item.label} down</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          update({
                            checklist: definition.checklist.filter((_, at) => at !== index),
                          });
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                        Remove<span className="sr-only"> {item.label}</span>
                      </Button>
                    </div>
                  )}
                </div>
              </fieldset>
            );
          })}
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                update({
                  checklist: [
                    ...definition.checklist,
                    {
                      key: uniqueKey(
                        'New item',
                        definition.checklist.map((item) => item.key),
                      ),
                      label: 'New item',
                      documentType: null,
                      required: true,
                      reviewRequired: false,
                      instructions: '',
                    },
                  ],
                });
              }}
            >
              <Plus aria-hidden="true" />
              Add checklist item
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One template: its versions, the draft editor, and publishing. Published
 * versions are shown read-only; changing them means starting a new draft.
 */
export function WorkflowTemplatePage() {
  const { templateId = '' } = useParams();
  const location = useLocation();
  const headingId = useId();
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [selected, setSelected] = useState<WorkflowVersion | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(
    typeof (location.state as { notice?: unknown } | null)?.notice === 'string'
      ? (location.state as { notice: string }).notice
      : null,
  );
  const [busy, setBusy] = useState<'save' | 'publish' | 'draft' | null>(null);

  const load = useCallback(
    async (versionId?: string, signal?: AbortSignal) => {
      try {
        const loaded = await getWorkflowTemplate(templateId, signal);
        setTemplate(loaded);
        const target =
          versionId ?? loaded.draft?.id ?? loaded.latestPublished?.id ?? loaded.versions[0]?.id;
        if (target !== undefined) {
          const version = await getWorkflowVersion(templateId, target, signal);
          setSelected(version);
          setDraft(version.definition);
        }
      } catch (error) {
        if (signal?.aborted !== true) {
          setNotice(toErrorNotice(error, 'Could not load the template'));
        }
      }
    },
    [templateId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const issues = useMemo(() => (draft === null ? [] : issuesFor(draft)), [draft]);
  const dirty =
    selected !== null &&
    draft !== null &&
    JSON.stringify(selected.definition) !== JSON.stringify(draft);

  async function run(kind: 'save' | 'publish' | 'draft', action: () => Promise<WorkflowVersion>) {
    setBusy(kind);
    setNotice(null);
    setSuccess(null);
    try {
      const version = await action();
      setSuccess(
        kind === 'save'
          ? 'Draft saved.'
          : kind === 'publish'
            ? `Version ${String(version.versionNumber)} published. New cases can use it now.`
            : `Draft version ${String(version.versionNumber)} started from the latest published version.`,
      );
      await load(version.id);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        setNotice({
          title: 'This draft changed',
          message:
            'Someone else saved this draft. Your edits are still shown; copy anything you need, then reload the latest version.',
          requestId: error.requestId,
        });
      } else {
        setNotice(toErrorNotice(error, 'Could not complete the action'));
      }
    } finally {
      setBusy(null);
    }
  }

  if (template === null || selected === null || draft === null) {
    return (
      <section aria-labelledby={headingId}>
        <DocumentTitle title="Workflow template" />
        <PageHeader id={headingId} title="Workflow template" />
        {notice === null ? (
          <LoadingMessage>Loading template…</LoadingMessage>
        ) : (
          <>
            <ErrorAlert notice={notice} />
            <Link to={ROUTE_PATHS.workflows} className={buttonVariants({ variant: 'outline' })}>
              Back to workflows
            </Link>
          </>
        )}
      </section>
    );
  }

  const isDraft = selected.state === 'draft';

  return (
    <section aria-labelledby={headingId}>
      <DocumentTitle title={template.name} />
      <PageHeader
        id={headingId}
        title={template.name}
        description={template.description.length > 0 ? template.description : undefined}
        actions={
          isDraft ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={!dirty || busy !== null}
                aria-busy={busy === 'save'}
                onClick={() =>
                  void run('save', () =>
                    saveWorkflowDraft(template.id, selected.id, draft, selected.version),
                  )
                }
              >
                {busy === 'save' ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Save aria-hidden="true" />
                )}
                Save draft
              </Button>
              <Button
                type="button"
                disabled={dirty || issues.length > 0 || busy !== null}
                aria-busy={busy === 'publish'}
                aria-describedby={`${headingId}-publish-help`}
                onClick={() =>
                  void run('publish', () =>
                    publishWorkflowVersion(template.id, selected.id, selected.version),
                  )
                }
              >
                {busy === 'publish' ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Send aria-hidden="true" />
                )}
                Publish version {selected.versionNumber}
              </Button>
            </>
          ) : template.draft === null ? (
            <Button
              type="button"
              disabled={busy !== null}
              aria-busy={busy === 'draft'}
              onClick={() => void run('draft', () => createWorkflowDraft(template.id))}
            >
              <FilePlus2 aria-hidden="true" />
              Start new draft
            </Button>
          ) : undefined
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}

      <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Versions">
        {template.versions.map((version) => (
          <Button
            key={version.id}
            type="button"
            size="sm"
            variant={version.id === selected.id ? 'default' : 'outline'}
            aria-pressed={version.id === selected.id}
            onClick={() => void load(version.id)}
          >
            Version {version.versionNumber}
            <Badge variant={version.state === 'draft' ? 'warning' : 'success'} className="ml-1">
              {version.state === 'draft' ? 'Draft' : 'Published'}
            </Badge>
          </Button>
        ))}
      </div>

      {isDraft ? (
        <div id={`${headingId}-publish-help`}>
          {dirty && (
            <InfoNotice>You have unsaved changes. Save the draft before publishing.</InfoNotice>
          )}
          {issues.length > 0 ? (
            <div
              role="status"
              className="mb-5 rounded-lg border border-warning/40 bg-warning-subtle p-4 text-sm"
            >
              <h2 className="font-semibold">Fix these before publishing</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            !dirty && (
              <InfoNotice>
                This draft is valid. Publishing freezes it as version {selected.versionNumber};
                cases opened on earlier versions keep their own workflow and checklist.
              </InfoNotice>
            )
          )}
        </div>
      ) : (
        <InfoNotice>
          Version {selected.versionNumber} was published
          {selected.publishedAt === null ? '' : ` on ${formatDateTime(selected.publishedAt)}`}
          {selected.publishedBy === null ? '' : ` by ${selected.publishedBy.displayName}`}.
          Published versions cannot change.
          {template.draft !== null && ' A newer draft exists.'}
        </InfoNotice>
      )}

      <div className="mb-5 flex flex-wrap gap-2" aria-label="Status summary">
        {draft.statuses.map((status) => (
          <Badge key={status.key} variant={STATUS_KIND_BADGE[status.kind]}>
            {status.initial ? '▶ ' : ''}
            {status.name}
          </Badge>
        ))}
      </div>

      <DefinitionEditor definition={draft} onChange={setDraft} readOnly={!isDraft} />
    </section>
  );
}

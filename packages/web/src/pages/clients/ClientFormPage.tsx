import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { LoaderCircle, Plus, Trash2 } from 'lucide-react';
import {
  CLIENT_LIMITS,
  ClientCreateRequestSchema,
  ClientUpdateRequestSchema,
  DuplicateOverrideReasonSchema,
  type Client,
  type ClientAssignee,
  type ClientCreateRequest,
  type ClientDuplicateCheckResponse,
  type ClientDuplicateMatch,
  type ClientType,
  type ClientUpdateRequest,
} from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { DocumentTitle } from '@/lib/document-title';
import { ApiError } from '../../api-client.js';
import {
  checkClientDuplicates,
  createClient,
  getClient,
  listClientAssignees,
  updateClient,
} from '../../client-api.js';
import {
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS, clientPath } from '../../routes.js';
import { toErrorNotice } from '../error-notice.js';
import { CLIENT_TYPE_LABELS, DUPLICATE_REASON_LABELS, contactSummary } from './client-format.js';

interface ContactDraft {
  readonly key: string;
  name: string;
  relationship: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

interface ClientDraft {
  type: ClientType;
  legalName: string;
  displayName: string;
  cnic: string;
  ntn: string;
  removeNtn: boolean;
  contacts: ContactDraft[];
  notes: string;
  assignedManagerUserId: string;
}

type FieldErrors = Readonly<Record<string, string>>;

let contactKey = 0;
function newContact(isPrimary: boolean): ContactDraft {
  contactKey += 1;
  return {
    key: `contact-${String(contactKey)}`,
    name: '',
    relationship: '',
    email: '',
    phone: '',
    isPrimary,
  };
}

function emptyDraft(): ClientDraft {
  return {
    type: 'individual',
    legalName: '',
    displayName: '',
    cnic: '',
    ntn: '',
    removeNtn: false,
    contacts: [newContact(true)],
    notes: '',
    assignedManagerUserId: '',
  };
}

function draftFromClient(client: Client): ClientDraft {
  return {
    type: client.type,
    legalName: client.legalName,
    displayName: client.displayName === client.legalName ? '' : client.displayName,
    cnic: '',
    ntn: '',
    removeNtn: false,
    contacts: client.contacts.map((contact) => ({
      ...newContact(contact.isPrimary),
      name: contact.name,
      relationship: contact.relationship ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
    })),
    notes: client.notes,
    assignedManagerUserId: client.assignedManager?.id ?? '',
  };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requestBody(draft: ClientDraft, mode: 'create' | 'edit'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: draft.type,
    legalName: draft.legalName,
    contacts: draft.contacts.map((contact) => ({
      name: contact.name,
      ...(optional(contact.relationship) === undefined
        ? {}
        : { relationship: optional(contact.relationship) }),
      ...(optional(contact.email) === undefined ? {} : { email: optional(contact.email) }),
      ...(optional(contact.phone) === undefined ? {} : { phone: optional(contact.phone) }),
      isPrimary: contact.isPrimary,
    })),
    notes: draft.notes,
    assignedManagerUserId:
      draft.assignedManagerUserId.length === 0 ? null : draft.assignedManagerUserId,
  };
  if (optional(draft.displayName) !== undefined) body['displayName'] = optional(draft.displayName);
  if (draft.type === 'individual') {
    if (mode === 'create' || optional(draft.cnic) !== undefined) body['cnic'] = draft.cnic;
  }
  if (draft.type === 'individual' && mode === 'edit' && draft.removeNtn) {
    body['ntn'] = null;
  } else if (draft.type === 'business' && mode === 'create') {
    body['ntn'] = draft.ntn;
  } else if (optional(draft.ntn) !== undefined) {
    body['ntn'] = draft.ntn;
  }
  return body;
}

function issuesToErrors(issues: readonly { path: (string | number)[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length === 0 ? 'form' : issue.path.map(String).join('.');
    errors[key] ??= issue.message;
  }
  return errors;
}

/** DOM id for a field path, so errors can focus and describe their input. */
function fieldId(path: string): string {
  return `client-${path.replaceAll('.', '-')}`;
}

function FormField({
  path,
  label,
  errors,
  description,
  children,
}: {
  path: string;
  label: string;
  errors: FieldErrors;
  description?: ReactNode;
  children: (props: {
    id: string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = fieldId(path);
  const error = errors[path];
  const describedBy = [
    description === undefined ? null : `${id}-help`,
    error === undefined ? null : `${id}-error`,
  ]
    .filter((value) => value !== null)
    .join(' ');
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({
        id,
        ...(error === undefined ? {} : { 'aria-invalid': true as const }),
        ...(describedBy.length === 0 ? {} : { 'aria-describedby': describedBy }),
      })}
      {description !== undefined && (
        <FieldDescription id={`${id}-help`}>{description}</FieldDescription>
      )}
      {error !== undefined && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

function DuplicateList({ matches }: { matches: readonly ClientDuplicateMatch[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {matches.map((match) => (
        <li key={match.clientId} className="text-sm">
          <Link
            to={clientPath(match.clientId)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {match.displayName} ({match.clientCode}
            <span className="sr-only">, opens in a new tab</span>)
          </Link>{' '}
          — {match.reasons.map((reason) => DUPLICATE_REASON_LABELS[reason]).join(', ')}
          {match.state === 'archived' && ' (archived)'}
        </li>
      ))}
    </ul>
  );
}

interface ComparisonRow {
  readonly label: string;
  readonly mine: string;
  readonly latest: string;
}

function comparisonRows(
  draft: ClientDraft,
  latest: Client,
  assignees: readonly ClientAssignee[],
): ComparisonRow[] {
  const managerName = (id: string) =>
    id.length === 0
      ? 'Unassigned'
      : (assignees.find((assignee) => assignee.id === id)?.displayName ?? 'Selected staff member');
  const rows: ComparisonRow[] = [
    { label: 'Legal name', mine: draft.legalName, latest: latest.legalName },
    {
      label: 'Display name',
      mine: optional(draft.displayName) ?? draft.legalName,
      latest: latest.displayName,
    },
    {
      label: 'Contacts',
      mine:
        draft.contacts
          .map((contact) =>
            [contact.name, optional(contact.email), optional(contact.phone)]
              .filter((part) => part !== undefined && part.length > 0)
              .join(' · '),
          )
          .join('; ') || 'None',
      latest: latest.contacts.map(contactSummary).join('; ') || 'None',
    },
    { label: 'Notes', mine: draft.notes || 'None', latest: latest.notes || 'None' },
    {
      label: 'Assigned manager',
      mine: managerName(draft.assignedManagerUserId),
      latest: latest.assignedManager?.displayName ?? 'Unassigned',
    },
  ];
  if (latest.type === 'individual') {
    rows.push({
      label: 'CNIC',
      mine: optional(draft.cnic) === undefined ? 'Unchanged' : 'New value entered',
      latest: latest.cnicMasked ?? '—',
    });
  }
  rows.push({
    label: 'NTN',
    mine: draft.removeNtn
      ? 'Remove'
      : optional(draft.ntn) === undefined
        ? 'Unchanged'
        : 'New value entered',
    latest: latest.ntnMasked ?? 'Not recorded',
  });
  return rows;
}

/**
 * Create or edit a client. The shared Zod contract gives field-level feedback
 * before the request; the API re-validates and is authoritative. Creation
 * runs a duplicate preview first. A stale edit (412) loads the latest saved
 * version next to the user's unsaved input, which is never discarded unless
 * the user chooses to.
 */
export function ClientFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { clientId = '' } = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [original, setOriginal] = useState<Client | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [assignees, setAssignees] = useState<readonly ClientAssignee[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [loading, setLoading] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<ClientDuplicateCheckResponse | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Client | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const conflictHeading = useRef<HTMLHeadingElement>(null);
  const duplicateHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listClientAssignees(controller.signal)
      .then((result) => {
        setAssignees(result.assignees);
      })
      .catch(() => {
        // Without the list the field still offers "Unassigned" and the current value.
      });
    if (mode === 'edit') {
      void getClient(clientId, controller.signal)
        .then((client) => {
          setOriginal(client);
          setVersion(client.version);
          setDraft(draftFromClient(client));
          setLoading(false);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setNotice(toErrorNotice(error, 'Could not load this client'));
            setLoading(false);
          }
        });
    }
    return () => {
      controller.abort();
    };
  }, [mode, clientId]);

  useEffect(() => {
    // Move focus to the first invalid field in reading order after errors render.
    if (focusRequest > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [focusRequest]);

  useEffect(() => {
    if (conflict !== null) conflictHeading.current?.focus();
  }, [conflict]);

  useEffect(() => {
    if (duplicates !== null) duplicateHeading.current?.focus();
  }, [duplicates]);

  function change(update: Partial<ClientDraft>): void {
    setDraft((current) => ({ ...current, ...update }));
    // A changed form invalidates an earlier duplicate review.
    setDuplicates(null);
  }

  function changeContact(index: number, update: Partial<ContactDraft>): void {
    setDraft((current) => ({
      ...current,
      contacts: current.contacts.map((contact, position) => {
        if (position === index) return { ...contact, ...update };
        // Only one contact can be primary.
        return update.isPrimary === true ? { ...contact, isPrimary: false } : contact;
      }),
    }));
    setDuplicates(null);
  }

  function showErrors(next: Record<string, string>): void {
    setErrors(next);
    setFocusRequest((count) => count + 1);
  }

  function handleSaveError(error: unknown): void {
    if (error instanceof ApiError) {
      if (error.code === 'VALIDATION_FAILED' && error.fieldErrors.length > 0) {
        showErrors(
          Object.fromEntries(error.fieldErrors.map((field) => [field.field, field.message])),
        );
      }
      if (error.code === 'CLIENT_IDENTIFIER_EXISTS') {
        showErrors({
          [draft.type === 'individual' ? 'cnic' : 'ntn']:
            'Another client already has this identifier.',
        });
      }
      if (error.code === 'ASSIGNEE_INVALID') {
        showErrors({ assignedManagerUserId: error.message });
      }
    }
    setNotice(toErrorNotice(error, 'Could not save the client'));
  }

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setNotice(null);
    const body = requestBody(draft, mode);
    const parsed =
      mode === 'create'
        ? ClientCreateRequestSchema.safeParse(body)
        : ClientUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      showErrors(issuesToErrors(parsed.error.issues));
      setNotice({ title: 'Check the form', message: 'Some fields need attention.' });
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (mode === 'create') {
        const request = parsed.data as ClientCreateRequest;
        const check = await checkClientDuplicates(request);
        if (check.blocking.length > 0 || check.warnings.length > 0) {
          setDuplicates(check);
          return;
        }
        const created = await createClient(request);
        void navigate(clientPath(created.id), { state: { notice: 'Client created.' } });
      } else {
        await save(parsed.data as ClientUpdateRequest);
      }
    } catch (error) {
      handleSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  async function save(request: ClientUpdateRequest): Promise<void> {
    if (version === null) return;
    try {
      const updated = await updateClient(clientId, request, version);
      void navigate(clientPath(updated.id), { state: { notice: 'Client saved.' } });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        // Keep the user's input; load the latest saved version beside it.
        const latest = await getClient(clientId);
        setConflict(latest);
        setVersion(latest.version);
        setNotice(null);
        return;
      }
      throw error;
    }
  }

  async function createAnyway(): Promise<void> {
    const reason = DuplicateOverrideReasonSchema.safeParse(overrideReason);
    if (!reason.success) {
      setOverrideError(reason.error.issues[0]?.message ?? 'Enter a reason.');
      document.getElementById('client-override-reason')?.focus();
      return;
    }
    setOverrideError(null);
    const parsed = ClientCreateRequestSchema.safeParse({
      ...requestBody(draft, 'create'),
      duplicateOverrideReason: reason.data,
    });
    if (!parsed.success) {
      showErrors(issuesToErrors(parsed.error.issues));
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const created = await createClient(parsed.data);
      void navigate(clientPath(created.id), { state: { notice: 'Client created.' } });
    } catch (error) {
      handleSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  const title = mode === 'create' ? 'New client' : `Edit ${original?.displayName ?? 'client'}`;

  if (loading || (mode === 'edit' && original === null)) {
    return (
      <section aria-labelledby="client-form-heading">
        <DocumentTitle title="Edit client" />
        <PageHeader id="client-form-heading" title="Edit client" />
        {notice !== null ? (
          <ErrorAlert notice={notice} />
        ) : (
          <LoadingMessage>Loading client…</LoadingMessage>
        )}
      </section>
    );
  }

  const cancelTo = mode === 'create' ? ROUTE_PATHS.clients : clientPath(clientId);
  const fieldProps = { errors };
  const archived = original?.state === 'archived';

  return (
    <section aria-labelledby="client-form-heading">
      {mode === 'edit' && <DocumentTitle title={title} />}
      <PageHeader
        id="client-form-heading"
        title={title}
        description={
          mode === 'edit' && original !== null
            ? `${original.clientCode} · ${CLIENT_TYPE_LABELS[original.type]}`
            : 'Fields marked required must be filled in before saving.'
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {archived && <InfoNotice tone="warning">Restore this client before editing it.</InfoNotice>}

      {conflict !== null && (
        <Card className="mb-5 border-warning" aria-labelledby="conflict-heading">
          <CardHeader>
            <CardTitle>
              <h2
                id="conflict-heading"
                ref={conflictHeading}
                tabIndex={-1}
                className="text-base font-semibold outline-none"
              >
                Someone else saved this client
              </h2>
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Your changes were not saved and are still in the form. Compare them with the latest
              saved version, then save again to apply yours on top of it, or discard yours.
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <caption className="sr-only">
                Your unsaved input compared with the latest saved version
              </caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Your unsaved input
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Latest saved
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows(draft, conflict, assignees).map((row) => (
                  <tr key={row.label} className="border-t align-top">
                    <th scope="row" className="py-2 pr-3 font-medium">
                      {row.label}
                      {row.mine !== row.latest && row.mine !== 'Unchanged' && (
                        <Badge variant="warning" className="ml-2">
                          Differs
                        </Badge>
                      )}
                    </th>
                    <td className="py-2 pr-3 break-words whitespace-pre-wrap">{row.mine}</td>
                    <td className="py-2 break-words whitespace-pre-wrap">{row.latest}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
          <CardFooter className="mt-4 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft(draftFromClient(conflict));
                setOriginal(conflict);
                setConflict(null);
              }}
            >
              Discard my changes and use the latest
            </Button>
            <Button
              type="button"
              onClick={() => {
                setOriginal(conflict);
                setConflict(null);
                document.getElementById(fieldId('legalName'))?.focus();
              }}
            >
              Keep reviewing my changes
            </Button>
          </CardFooter>
        </Card>
      )}

      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => void submit(event)}
        className="max-w-3xl space-y-5"
      >
        <Card>
          <CardContent>
            <FieldGroup>
              {mode === 'create' ? (
                <FormField path="type" label="Client type" {...fieldProps}>
                  {(props) => (
                    <NativeSelect
                      {...props}
                      className="w-full"
                      value={draft.type}
                      onChange={(event) => {
                        change({ type: event.target.value as ClientType });
                      }}
                    >
                      <NativeSelectOption value="individual">Individual</NativeSelectOption>
                      <NativeSelectOption value="business">Business</NativeSelectOption>
                    </NativeSelect>
                  )}
                </FormField>
              ) : null}
              <FormField path="legalName" label="Legal name (required)" {...fieldProps}>
                {(props) => (
                  <Input
                    {...props}
                    autoComplete="off"
                    maxLength={CLIENT_LIMITS.nameMax}
                    value={draft.legalName}
                    onChange={(event) => {
                      change({ legalName: event.target.value });
                    }}
                  />
                )}
              </FormField>
              <FormField
                path="displayName"
                label="Display name"
                description="Optional. Defaults to the legal name."
                {...fieldProps}
              >
                {(props) => (
                  <Input
                    {...props}
                    autoComplete="off"
                    maxLength={CLIENT_LIMITS.nameMax}
                    value={draft.displayName}
                    onChange={(event) => {
                      change({ displayName: event.target.value });
                    }}
                  />
                )}
              </FormField>
              {draft.type === 'individual' && (
                <FormField
                  path="cnic"
                  label={mode === 'create' ? 'CNIC (required)' : 'CNIC'}
                  description={
                    mode === 'edit'
                      ? `Stored as ${original?.cnicMasked ?? '—'}. Leave blank to keep it.`
                      : '13 digits, for example 12345-1234567-1. Stored encrypted and shown masked.'
                  }
                  {...fieldProps}
                >
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={15}
                      value={draft.cnic}
                      onChange={(event) => {
                        change({ cnic: event.target.value });
                      }}
                    />
                  )}
                </FormField>
              )}
              <FormField
                path="ntn"
                label={draft.type === 'business' && mode === 'create' ? 'NTN (required)' : 'NTN'}
                description={
                  mode === 'edit'
                    ? `Stored as ${original?.ntnMasked ?? 'not recorded'}. Leave blank to keep it.`
                    : draft.type === 'business'
                      ? '7 digits with an optional check digit, for example 1234567-8.'
                      : 'Optional. 7 digits with an optional check digit, or a CNIC-based NTN.'
                }
                {...fieldProps}
              >
                {(props) => (
                  <Input
                    {...props}
                    autoComplete="off"
                    maxLength={15}
                    disabled={draft.removeNtn}
                    value={draft.ntn}
                    onChange={(event) => {
                      change({ ntn: event.target.value });
                    }}
                  />
                )}
              </FormField>
              {mode === 'edit' && draft.type === 'individual' && original?.ntnMasked !== null && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={draft.removeNtn}
                    onChange={(event) => {
                      change({ removeNtn: event.target.checked, ntn: '' });
                    }}
                  />
                  Remove the stored NTN
                </label>
              )}
              <FormField path="assignedManagerUserId" label="Assigned manager" {...fieldProps}>
                {(props) => (
                  <NativeSelect
                    {...props}
                    className="w-full"
                    value={draft.assignedManagerUserId}
                    onChange={(event) => {
                      change({ assignedManagerUserId: event.target.value });
                    }}
                  >
                    <NativeSelectOption value="">Unassigned</NativeSelectOption>
                    {original?.assignedManager !== null &&
                      original?.assignedManager !== undefined &&
                      !assignees.some((a) => a.id === original.assignedManager?.id) && (
                        <NativeSelectOption value={original.assignedManager.id}>
                          {original.assignedManager.displayName} (inactive)
                        </NativeSelectOption>
                      )}
                    {assignees.map((assignee) => (
                      <NativeSelectOption key={assignee.id} value={assignee.id}>
                        {assignee.displayName}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <FieldSet>
              <FieldLegend>Contacts</FieldLegend>
              <FieldDescription>
                Each contact needs an email address or a phone number. Mark one as primary.
              </FieldDescription>
              {errors['contacts'] !== undefined && (
                <FieldError id={fieldId('contacts')}>{errors['contacts']}</FieldError>
              )}
              {draft.contacts.map((contact, index) => {
                const base = `contacts.${String(index)}`;
                return (
                  <FieldSet key={contact.key} className="rounded-lg border p-4">
                    <FieldLegend variant="label">Contact {index + 1}</FieldLegend>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField path={`${base}.name`} label="Name" {...fieldProps}>
                        {(props) => (
                          <Input
                            {...props}
                            maxLength={CLIENT_LIMITS.contactNameMax}
                            value={contact.name}
                            onChange={(event) => {
                              changeContact(index, { name: event.target.value });
                            }}
                          />
                        )}
                      </FormField>
                      <FormField path={`${base}.relationship`} label="Relationship" {...fieldProps}>
                        {(props) => (
                          <Input
                            {...props}
                            maxLength={CLIENT_LIMITS.relationshipMax}
                            placeholder="Self, accountant, director…"
                            value={contact.relationship}
                            onChange={(event) => {
                              changeContact(index, { relationship: event.target.value });
                            }}
                          />
                        )}
                      </FormField>
                      <FormField path={`${base}.email`} label="Email" {...fieldProps}>
                        {(props) => (
                          <Input
                            {...props}
                            type="email"
                            autoComplete="off"
                            maxLength={CLIENT_LIMITS.emailMax}
                            value={contact.email}
                            onChange={(event) => {
                              changeContact(index, { email: event.target.value });
                            }}
                          />
                        )}
                      </FormField>
                      <FormField path={`${base}.phone`} label="Phone" {...fieldProps}>
                        {(props) => (
                          <Input
                            {...props}
                            type="tel"
                            autoComplete="off"
                            maxLength={CLIENT_LIMITS.phoneMax}
                            value={contact.phone}
                            onChange={(event) => {
                              changeContact(index, { phone: event.target.value });
                            }}
                          />
                        )}
                      </FormField>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={contact.isPrimary}
                          onChange={(event) => {
                            changeContact(index, { isPrimary: event.target.checked });
                          }}
                        />
                        Primary contact
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          change({
                            contacts: draft.contacts.filter((_, position) => position !== index),
                          });
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                        Remove contact {index + 1}
                      </Button>
                    </div>
                  </FieldSet>
                );
              })}
              {draft.contacts.length < CLIENT_LIMITS.contactsMax && (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={() => {
                    change({
                      contacts: [...draft.contacts, newContact(draft.contacts.length === 0)],
                    });
                  }}
                >
                  <Plus aria-hidden="true" />
                  Add contact
                </Button>
              )}
            </FieldSet>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <FormField
              path="notes"
              label="Notes"
              description={`Up to ${String(CLIENT_LIMITS.notesMax)} characters. Notes are never copied into activity history.`}
              {...fieldProps}
            >
              {(props) => (
                <Textarea
                  {...props}
                  rows={4}
                  maxLength={CLIENT_LIMITS.notesMax}
                  value={draft.notes}
                  onChange={(event) => {
                    change({ notes: event.target.value });
                  }}
                />
              )}
            </FormField>
          </CardContent>
        </Card>

        {duplicates !== null && (
          <Card
            className={duplicates.blocking.length > 0 ? 'border-destructive' : 'border-warning'}
          >
            <CardHeader>
              <CardTitle>
                <h2
                  ref={duplicateHeading}
                  tabIndex={-1}
                  className="text-base font-semibold outline-none"
                >
                  {duplicates.blocking.length > 0
                    ? 'This client already exists'
                    : 'This client may already exist'}
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {duplicates.blocking.length > 0 ? (
                <>
                  <p className="text-sm">
                    Another client has the same CNIC or NTN. Exact identifier duplicates cannot be
                    created; open the existing client instead.
                  </p>
                  <DuplicateList matches={duplicates.blocking} />
                </>
              ) : (
                <>
                  <p className="text-sm">
                    These clients share an email address, phone number, or name. Check them before
                    creating a new record.
                  </p>
                  <DuplicateList matches={duplicates.warnings} />
                  <Field className="mt-4" data-invalid={overrideError === null ? undefined : true}>
                    <FieldLabel htmlFor="client-override-reason">
                      Reason for creating a separate client (required)
                    </FieldLabel>
                    <Textarea
                      id="client-override-reason"
                      rows={2}
                      maxLength={CLIENT_LIMITS.overrideReasonMax}
                      value={overrideReason}
                      {...(overrideError === null
                        ? { 'aria-describedby': 'client-override-reason-help' }
                        : {
                            'aria-invalid': true,
                            'aria-describedby':
                              'client-override-reason-help client-override-reason-error',
                          })}
                      onChange={(event) => {
                        setOverrideReason(event.target.value);
                      }}
                    />
                    <FieldDescription id="client-override-reason-help">
                      Recorded in the client&apos;s audit history. Only managers and administrators
                      can override a duplicate warning.
                    </FieldDescription>
                    {overrideError !== null && (
                      <FieldError id="client-override-reason-error">{overrideError}</FieldError>
                    )}
                  </Field>
                </>
              )}
            </CardContent>
            {duplicates.blocking.length === 0 && (
              <CardFooter className="mt-4">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={saving}
                  aria-busy={saving}
                  onClick={() => void createAnyway()}
                >
                  {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                  Create anyway
                </Button>
              </CardFooter>
            )}
          </Card>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving || archived} aria-busy={saving}>
            {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {saving
              ? 'Saving…'
              : mode === 'create'
                ? 'Check and create client'
                : conflict === null
                  ? 'Save changes'
                  : 'Save my changes over the latest'}
          </Button>
          <Link to={cancelTo} className={buttonVariants({ variant: 'outline' })}>
            Cancel
          </Link>
        </div>
      </form>
    </section>
  );
}

import { useEffect, useId, useMemo, useState, type SubmitEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import {
  CaseCreateRequestSchema,
  FIRM_CURRENCY,
  addDaysToDate,
  calendarDateIn,
  formatMinorAmount,
  type CasePerson,
  type ClientListItem,
  type ServiceType,
  type WorkflowTemplateSummary,
} from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '../../api-client.js';
import {
  createCase,
  listCaseAssignees,
  listServiceTypes,
  listWorkflowTemplates,
} from '../../case-api.js';
import { getClient, listClients } from '../../client-api.js';
import {
  ErrorAlert,
  InfoNotice,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { casePath } from '../../routes.js';
import { useSession } from '../../session/session-context.js';
import { toErrorNotice } from '../error-notice.js';

const FIRM_TIMEZONE = 'Asia/Karachi';

interface FormState {
  clientId: string;
  serviceTypeId: string;
  taxYear: string;
  workflowVersionId: string;
  dueDate: string;
  primaryConsultantUserId: string;
  reviewerUserId: string;
  notes: string;
}

type FieldName = keyof FormState | 'duplicateOverrideReason';
type Errors = Partial<Record<FieldName, string | undefined>>;

/** The current Pakistani tax year ends on 30 June of the year it is named after. */
function currentTaxYear(today: string): number {
  const [year = '2026', month = '01'] = today.split('-');
  return Number(month) >= 7 ? Number(year) + 1 : Number(year);
}

/** Opens a tax case (TD-304). Defaults come from the chosen service. */
export function CaseCreatePage() {
  const headingId = useId();
  const navigate = useNavigate();
  const [parameters] = useSearchParams();
  const { state, can } = useSession();
  const userId = state.status === 'authenticated' ? state.session.user.id : '';
  const canAssign = can('cases.assign');
  const today = useMemo(() => calendarDateIn(FIRM_TIMEZONE, new Date()), []);

  const [clients, setClients] = useState<readonly ClientListItem[] | null>(null);
  const [services, setServices] = useState<readonly ServiceType[]>([]);
  const [templates, setTemplates] = useState<readonly WorkflowTemplateSummary[]>([]);
  const [people, setPeople] = useState<readonly CasePerson[]>([]);
  const [form, setForm] = useState<FormState>({
    clientId: parameters.get('client') ?? '',
    serviceTypeId: '',
    taxYear: String(currentTaxYear(today)),
    workflowVersionId: '',
    dueDate: '',
    primaryConsultantUserId: canAssign ? '' : userId,
    reviewerUserId: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      listClients({ state: 'active', limit: 100 }, controller.signal),
      listServiceTypes('active', controller.signal),
      listWorkflowTemplates(controller.signal),
      listCaseAssignees(controller.signal),
    ])
      .then(async ([clientList, serviceList, templateList, assignees]) => {
        // The picker lists the first page of active clients; a client chosen
        // from its own page is always included, however long the list is.
        const preselected = parameters.get('client');
        let choices = clientList.clients;
        if (preselected !== null && !choices.some((client) => client.id === preselected)) {
          const client = await getClient(preselected, controller.signal).catch(() => null);
          if (client?.state === 'active') {
            choices = [
              {
                id: client.id,
                clientCode: client.clientCode,
                type: client.type,
                legalName: client.legalName,
                displayName: client.displayName,
                cnicMasked: client.cnicMasked,
                ntnMasked: client.ntnMasked,
                primaryContact: client.contacts.find((contact) => contact.isPrimary) ?? null,
                assignedManager: client.assignedManager,
                state: client.state,
                updatedAt: client.updatedAt,
              },
              ...choices,
            ];
          }
        }
        setClients(choices);
        setServices(serviceList.serviceTypes);
        setTemplates(
          templateList.templates.filter((template) => template.latestPublished !== null),
        );
        setPeople(assignees.assignees);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setClients([]);
          setNotice(toErrorNotice(error, 'Could not load the case form'));
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setDuplicate(null);
  }

  function chooseService(serviceTypeId: string): void {
    const service = services.find((entry) => entry.id === serviceTypeId);
    const template = templates.find((entry) => entry.id === service?.defaultWorkflowTemplate?.id);
    setForm((current) => ({
      ...current,
      serviceTypeId,
      dueDate:
        service === undefined
          ? current.dueDate
          : addDaysToDate(today, service.defaultDeadlineOffsetDays),
      workflowVersionId: template?.latestPublished?.id ?? current.workflowVersionId,
    }));
    setErrors({});
    setDuplicate(null);
  }

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = CaseCreateRequestSchema.safeParse({
      clientId: form.clientId,
      serviceTypeId: form.serviceTypeId,
      taxYear: Number(form.taxYear),
      workflowVersionId: form.workflowVersionId,
      dueDate: form.dueDate,
      primaryConsultantUserId:
        form.primaryConsultantUserId.length === 0 ? null : form.primaryConsultantUserId,
      reviewerUserId: form.reviewerUserId.length === 0 ? null : form.reviewerUserId,
      notes: form.notes,
      ...(duplicate === null ? {} : { duplicateOverrideReason: overrideReason }),
    });
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '') as FieldName;
        const friendly =
          issue.code === 'invalid_string' && field !== 'dueDate'
            ? 'Choose an option.'
            : issue.message;
        next[field] ??= friendly;
      }
      setErrors(next);
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const created = await createCase(parsed.data);
      void navigate(casePath(created.id), {
        state: { notice: `Case ${created.caseCode} opened.` },
      });
    } catch (error) {
      setSaving(false);
      if (error instanceof ApiError && error.code === 'CASE_DUPLICATE_WARNING') {
        setDuplicate(error.message);
        return;
      }
      if (error instanceof ApiError && error.fieldErrors.length > 0) {
        const next: Errors = {};
        for (const fieldError of error.fieldErrors) {
          next[fieldError.field as FieldName] ??= fieldError.message;
        }
        setErrors(next);
      }
      setNotice(toErrorNotice(error, 'Could not open the case'));
    }
  }

  const selectedService = services.find((service) => service.id === form.serviceTypeId);
  const field = (name: FieldName) => ({
    'aria-invalid': errors[name] !== undefined,
    'aria-describedby': errors[name] === undefined ? undefined : `${headingId}-${name}-error`,
  });
  const error = (name: FieldName) => (
    <FieldError id={`${headingId}-${name}-error`}>{errors[name]}</FieldError>
  );

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="New case"
        description="Open a tax case for a client. The service's fee and the workflow version are copied into the case."
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {clients === null ? (
        <LoadingMessage>Loading…</LoadingMessage>
      ) : (
        <Card className="max-w-3xl">
          <CardContent>
            <form noValidate onSubmit={(event) => void submit(event)} className="space-y-5">
              {!canAssign && (
                <InfoNotice>
                  You will be the primary consultant. A manager can add a reviewer or reassign the
                  case later.
                </InfoNotice>
              )}
              <Field data-invalid={errors.clientId !== undefined}>
                <FieldLabel htmlFor={`${headingId}-client`}>Client</FieldLabel>
                <NativeSelect
                  id={`${headingId}-client`}
                  className="w-full"
                  value={form.clientId}
                  {...field('clientId')}
                  onChange={(event) => {
                    set('clientId', event.target.value);
                  }}
                >
                  <NativeSelectOption value="">Choose a client</NativeSelectOption>
                  {clients.map((client) => (
                    <NativeSelectOption key={client.id} value={client.id}>
                      {client.displayName} ({client.clientCode})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {error('clientId')}
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field data-invalid={errors.serviceTypeId !== undefined}>
                  <FieldLabel htmlFor={`${headingId}-service`}>Service</FieldLabel>
                  <NativeSelect
                    id={`${headingId}-service`}
                    className="w-full"
                    value={form.serviceTypeId}
                    {...field('serviceTypeId')}
                    onChange={(event) => {
                      chooseService(event.target.value);
                    }}
                  >
                    <NativeSelectOption value="">Choose a service</NativeSelectOption>
                    {services.map((service) => (
                      <NativeSelectOption key={service.id} value={service.id}>
                        {service.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {selectedService !== undefined && (
                    <FieldDescription>
                      Fee {FIRM_CURRENCY} {formatMinorAmount(selectedService.defaultFeeMinor)}
                    </FieldDescription>
                  )}
                  {error('serviceTypeId')}
                </Field>
                <Field data-invalid={errors.taxYear !== undefined}>
                  <FieldLabel htmlFor={`${headingId}-year`}>Tax year</FieldLabel>
                  <Input
                    id={`${headingId}-year`}
                    inputMode="numeric"
                    maxLength={4}
                    value={form.taxYear}
                    {...field('taxYear')}
                    onChange={(event) => {
                      set('taxYear', event.target.value);
                    }}
                  />
                  {error('taxYear')}
                </Field>
                <Field data-invalid={errors.workflowVersionId !== undefined}>
                  <FieldLabel htmlFor={`${headingId}-workflow`}>Workflow</FieldLabel>
                  <NativeSelect
                    id={`${headingId}-workflow`}
                    className="w-full"
                    value={form.workflowVersionId}
                    {...field('workflowVersionId')}
                    onChange={(event) => {
                      set('workflowVersionId', event.target.value);
                    }}
                  >
                    <NativeSelectOption value="">Choose a workflow</NativeSelectOption>
                    {templates.map((template) => (
                      <NativeSelectOption
                        key={template.id}
                        value={template.latestPublished?.id ?? ''}
                      >
                        {template.name} (version {template.latestPublished?.versionNumber})
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {error('workflowVersionId')}
                </Field>
                <Field data-invalid={errors.dueDate !== undefined}>
                  <FieldLabel htmlFor={`${headingId}-due`}>Due date</FieldLabel>
                  <Input
                    id={`${headingId}-due`}
                    type="date"
                    value={form.dueDate}
                    {...field('dueDate')}
                    onChange={(event) => {
                      set('dueDate', event.target.value);
                    }}
                  />
                  {error('dueDate')}
                </Field>
                <Field data-invalid={errors.primaryConsultantUserId !== undefined}>
                  <FieldLabel htmlFor={`${headingId}-consultant`}>Primary consultant</FieldLabel>
                  <NativeSelect
                    id={`${headingId}-consultant`}
                    className="w-full"
                    value={form.primaryConsultantUserId}
                    disabled={!canAssign}
                    {...field('primaryConsultantUserId')}
                    onChange={(event) => {
                      set('primaryConsultantUserId', event.target.value);
                    }}
                  >
                    <NativeSelectOption value="">Unassigned</NativeSelectOption>
                    {people.map((person) => (
                      <NativeSelectOption key={person.id} value={person.id}>
                        {person.displayName}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {error('primaryConsultantUserId')}
                </Field>
                <Field data-invalid={errors.reviewerUserId !== undefined}>
                  <FieldLabel htmlFor={`${headingId}-reviewer`}>Reviewer (optional)</FieldLabel>
                  <NativeSelect
                    id={`${headingId}-reviewer`}
                    className="w-full"
                    value={form.reviewerUserId}
                    disabled={!canAssign}
                    {...field('reviewerUserId')}
                    onChange={(event) => {
                      set('reviewerUserId', event.target.value);
                    }}
                  >
                    <NativeSelectOption value="">No reviewer</NativeSelectOption>
                    {people.map((person) => (
                      <NativeSelectOption key={person.id} value={person.id}>
                        {person.displayName}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {error('reviewerUserId')}
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor={`${headingId}-notes`}>Notes</FieldLabel>
                <Textarea
                  id={`${headingId}-notes`}
                  value={form.notes}
                  maxLength={4000}
                  onChange={(event) => {
                    set('notes', event.target.value);
                  }}
                />
              </Field>

              {duplicate !== null && (
                <div
                  role="alert"
                  className="space-y-3 rounded-lg border border-warning/40 bg-warning-subtle p-4"
                >
                  <h2 className="text-sm font-semibold">Possible duplicate case</h2>
                  <p className="text-sm">{duplicate}</p>
                  <Field data-invalid={errors.duplicateOverrideReason !== undefined}>
                    <FieldLabel htmlFor={`${headingId}-override`}>
                      Reason to open another case
                    </FieldLabel>
                    <Textarea
                      id={`${headingId}-override`}
                      value={overrideReason}
                      maxLength={500}
                      {...field('duplicateOverrideReason')}
                      onChange={(event) => {
                        setOverrideReason(event.target.value);
                        setErrors((current) => ({
                          ...current,
                          duplicateOverrideReason: undefined,
                        }));
                      }}
                    />
                    {error('duplicateOverrideReason')}
                  </Field>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void navigate(-1);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saving} aria-busy={saving}>
                  {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                  {duplicate === null ? 'Open case' : 'Open case anyway'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

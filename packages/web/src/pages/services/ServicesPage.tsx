import { useCallback, useEffect, useId, useState, type SubmitEvent } from 'react';
import { Archive, ArchiveRestore, LoaderCircle, Pencil, Plus } from 'lucide-react';
import {
  DUPLICATE_CASE_POLICIES,
  FIRM_CURRENCY,
  ServiceTypeCreateRequestSchema,
  formatMinorAmount,
  parseMajorAmount,
  type DuplicateCasePolicy,
  type FieldError as ApiFieldError,
  type ServiceType,
  type WorkflowTemplateSummary,
} from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
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
import { ApiError } from '../../api-client.js';
import {
  createServiceType,
  listServiceTypes,
  listWorkflowTemplates,
  setServiceTypeArchived,
  updateServiceType,
} from '../../case-api.js';
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  SuccessNotice,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { toErrorNotice } from '../error-notice.js';
import { DUPLICATE_POLICY_LABELS } from '../cases/case-format.js';

interface FormState {
  name: string;
  description: string;
  fee: string;
  offset: string;
  policy: DuplicateCasePolicy;
  templateId: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  fee: '0',
  offset: '30',
  policy: 'warn',
  templateId: '',
};

function formFrom(service: ServiceType): FormState {
  return {
    name: service.name,
    description: service.description,
    fee: formatMinorAmount(service.defaultFeeMinor).replace(/,/gu, ''),
    offset: String(service.defaultDeadlineOffsetDays),
    policy: service.duplicateCasePolicy,
    templateId: service.defaultWorkflowTemplate?.id ?? '',
  };
}

type Errors = Partial<Record<keyof FormState, string>>;

const FIELD_FOR: Readonly<Record<string, keyof FormState>> = {
  name: 'name',
  description: 'description',
  defaultFeeMinor: 'fee',
  defaultDeadlineOffsetDays: 'offset',
  duplicateCasePolicy: 'policy',
  defaultWorkflowTemplateId: 'templateId',
};

function mapErrors(errors: readonly ApiFieldError[]): Errors {
  const mapped: Errors = {};
  for (const error of errors) {
    const key = FIELD_FOR[error.field];
    if (key !== undefined && mapped[key] === undefined) {
      mapped[key] = error.message;
    }
  }
  return mapped;
}

function ServiceForm({
  editing,
  templates,
  onSaved,
  onCancel,
}: {
  editing: ServiceType | null;
  templates: readonly WorkflowTemplateSummary[];
  onSaved: (service: ServiceType, message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<FormState>(editing === null ? EMPTY_FORM : formFrom(editing));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const fee = parseMajorAmount(form.fee);
    const offset = /^\d+$/u.test(form.offset.trim()) ? Number(form.offset) : Number.NaN;
    const local: Errors = {};
    if (fee === null) local.fee = 'Enter an amount such as 15000 or 15000.50.';
    if (Number.isNaN(offset)) local.offset = 'Enter a whole number of days.';
    const parsed = ServiceTypeCreateRequestSchema.safeParse({
      name: form.name,
      description: form.description,
      defaultFeeMinor: fee ?? 0,
      defaultDeadlineOffsetDays: Number.isNaN(offset) ? 0 : offset,
      duplicateCasePolicy: form.policy,
      defaultWorkflowTemplateId: form.templateId.length === 0 ? null : form.templateId,
    });
    if (!parsed.success) {
      Object.assign(
        local,
        mapErrors(
          parsed.error.issues.map((issue) => ({
            field: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        ),
        local,
      );
    }
    setErrors(local);
    if (!parsed.success || Object.keys(local).length > 0) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved =
        editing === null
          ? await createServiceType(parsed.data)
          : await updateServiceType(editing.id, parsed.data, editing.version);
      onSaved(saved, editing === null ? 'Service created.' : 'Service saved.');
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(mapErrors(error.fieldErrors));
      }
      if (error instanceof ApiError && error.code === 'PRECONDITION_FAILED') {
        setNotice({
          title: 'This service changed',
          message: 'Someone else saved this service. Close this panel to load the latest version.',
          requestId: error.requestId,
        });
      } else {
        setNotice(toErrorNotice(error, 'Could not save the service'));
      }
    } finally {
      setSaving(false);
    }
  }

  const describedBy = (key: keyof FormState, help?: string) =>
    [errors[key] === undefined ? null : `${id}-${key}-error`, help ?? null]
      .filter((part) => part !== null)
      .join(' ') || undefined;

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>{editing === null ? 'New service' : `Edit ${editing.name}`}</SheetTitle>
        <SheetDescription>
          Cases copy the name and fee when they are opened, so changes here never rewrite existing
          cases.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto px-4">
        {notice !== null && <ErrorAlert notice={notice} />}
        <Field data-invalid={errors.name !== undefined}>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            value={form.name}
            maxLength={120}
            aria-invalid={errors.name !== undefined}
            aria-describedby={describedBy('name')}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
          <FieldError id={`${id}-name-error`}>{errors.name}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
          <Textarea
            id={`${id}-description`}
            value={form.description}
            maxLength={1000}
            onChange={(event) => {
              set('description', event.target.value);
            }}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.fee !== undefined}>
            <FieldLabel htmlFor={`${id}-fee`}>Default fee ({FIRM_CURRENCY})</FieldLabel>
            <Input
              id={`${id}-fee`}
              inputMode="decimal"
              value={form.fee}
              aria-invalid={errors.fee !== undefined}
              aria-describedby={describedBy('fee')}
              onChange={(event) => {
                set('fee', event.target.value);
              }}
            />
            <FieldError id={`${id}-fee-error`}>{errors.fee}</FieldError>
          </Field>
          <Field data-invalid={errors.offset !== undefined}>
            <FieldLabel htmlFor={`${id}-offset`}>Default deadline (days)</FieldLabel>
            <Input
              id={`${id}-offset`}
              inputMode="numeric"
              value={form.offset}
              aria-invalid={errors.offset !== undefined}
              aria-describedby={describedBy('offset', `${id}-offset-help`)}
              onChange={(event) => {
                set('offset', event.target.value);
              }}
            />
            <FieldDescription id={`${id}-offset-help`}>
              Days after a case is opened.
            </FieldDescription>
            <FieldError id={`${id}-offset-error`}>{errors.offset}</FieldError>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${id}-policy`}>Duplicate open cases</FieldLabel>
          <NativeSelect
            id={`${id}-policy`}
            className="w-full"
            value={form.policy}
            aria-describedby={`${id}-policy-help`}
            onChange={(event) => {
              set('policy', event.target.value as DuplicateCasePolicy);
            }}
          >
            {DUPLICATE_CASE_POLICIES.map((policy) => (
              <NativeSelectOption key={policy} value={policy}>
                {DUPLICATE_POLICY_LABELS[policy]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription id={`${id}-policy-help`}>
            Applies when a client already has an open case for this service and tax year.
          </FieldDescription>
        </Field>
        <Field data-invalid={errors.templateId !== undefined}>
          <FieldLabel htmlFor={`${id}-template`}>Default workflow</FieldLabel>
          <NativeSelect
            id={`${id}-template`}
            className="w-full"
            value={form.templateId}
            aria-invalid={errors.templateId !== undefined}
            aria-describedby={describedBy('templateId')}
            onChange={(event) => {
              set('templateId', event.target.value);
            }}
          >
            <NativeSelectOption value="">None</NativeSelectOption>
            {templates.map((template) => (
              <NativeSelectOption key={template.id} value={template.id}>
                {template.name}
                {template.latestPublished === null ? ' (not published yet)' : ''}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError id={`${id}-templateId-error`}>{errors.templateId}</FieldError>
        </Field>
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          {editing === null ? 'Create service' : 'Save service'}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * The firm's service catalog (TD-301). Archived services stay listed under
 * "Archived" and keep their cases; they cannot be chosen for new cases.
 */
export function ServicesPage() {
  const headingId = useId();
  const [state, setState] = useState<'active' | 'archived' | 'all'>('active');
  const [services, setServices] = useState<readonly ServiceType[] | null>(null);
  const [templates, setTemplates] = useState<readonly WorkflowTemplateSummary[]>([]);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServiceType | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [list, templateList] = await Promise.all([
          listServiceTypes(state, signal),
          listWorkflowTemplates(signal),
        ]);
        setServices(list.serviceTypes);
        setTemplates(templateList.templates);
      } catch (error) {
        if (signal?.aborted !== true) {
          setServices([]);
          setNotice(toErrorNotice(error, 'Could not load services'));
        }
      }
    },
    [state],
  );

  useEffect(() => {
    const controller = new AbortController();
    setServices(null);
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  async function toggleArchived(service: ServiceType): Promise<void> {
    setBusyId(service.id);
    setNotice(null);
    setSuccess(null);
    try {
      const archiving = service.state === 'active';
      await setServiceTypeArchived(service.id, archiving, service.version);
      setSuccess(archiving ? `${service.name} archived.` : `${service.name} restored.`);
      await load();
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not change the service'));
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Services"
        description="The services the firm offers, with default fees, deadlines, and workflows for new cases."
        actions={
          <Button
            type="button"
            onClick={() => {
              setEditing('new');
            }}
          >
            <Plus aria-hidden="true" />
            New service
          </Button>
        }
      />
      <div className="mb-4 max-w-xs">
        <Field>
          <FieldLabel htmlFor={`${headingId}-state`}>Show</FieldLabel>
          <NativeSelect
            id={`${headingId}-state`}
            className="w-full"
            value={state}
            onChange={(event) => {
              setState(event.target.value as typeof state);
            }}
          >
            <NativeSelectOption value="active">Active services</NativeSelectOption>
            <NativeSelectOption value="archived">Archived services</NativeSelectOption>
            <NativeSelectOption value="all">All services</NativeSelectOption>
          </NativeSelect>
        </Field>
      </div>
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {services === null ? (
        <LoadingMessage>Loading services…</LoadingMessage>
      ) : (
        <Card className="py-0">
          {services.length === 0 ? (
            <EmptyState title={state === 'active' ? 'No services yet' : 'No services to show'}>
              {state === 'active' ? 'Create a service so staff can open cases for it.' : undefined}
            </EmptyState>
          ) : (
            <Table>
              <TableCaption className="sr-only">Services</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead className="text-right">Default fee</TableHead>
                  <TableHead>Deadline</TableHead>
                  <TableHead>Duplicates</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {services.map((service) => (
                  <TableRow key={service.id}>
                    <TableCell>
                      <div className="font-medium">{service.name}</div>
                      {service.description.length > 0 && (
                        <div className="max-w-72 truncate text-xs text-muted-foreground">
                          {service.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {FIRM_CURRENCY} {formatMinorAmount(service.defaultFeeMinor)}
                    </TableCell>
                    <TableCell>{service.defaultDeadlineOffsetDays} days</TableCell>
                    <TableCell>
                      {service.duplicateCasePolicy === 'block' ? 'Blocked' : 'Warn'}
                    </TableCell>
                    <TableCell>{service.defaultWorkflowTemplate?.name ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={service.state === 'active' ? 'success' : 'secondary'}>
                        {service.state === 'active' ? 'Active' : 'Archived'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {service.state === 'active' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(service);
                          }}
                        >
                          <Pencil aria-hidden="true" />
                          Edit<span className="sr-only"> {service.name}</span>
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyId === service.id}
                        aria-busy={busyId === service.id}
                        onClick={() => void toggleArchived(service)}
                      >
                        {service.state === 'active' ? (
                          <Archive aria-hidden="true" />
                        ) : (
                          <ArchiveRestore aria-hidden="true" />
                        )}
                        {service.state === 'active' ? 'Archive' : 'Restore'}
                        <span className="sr-only"> {service.name}</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
      <Sheet
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:max-w-md">
          {editing !== null && (
            <ServiceForm
              key={editing === 'new' ? 'new' : editing.id}
              editing={editing === 'new' ? null : editing}
              templates={templates}
              onCancel={() => {
                setEditing(null);
              }}
              onSaved={(_saved, message) => {
                setEditing(null);
                setSuccess(message);
                setNotice(null);
                void load();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

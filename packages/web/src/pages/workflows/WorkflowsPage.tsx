import { useEffect, useId, useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { LoaderCircle, Plus } from 'lucide-react';
import { STARTER_WORKFLOW_DEFINITION, type WorkflowTemplateSummary } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { createWorkflowTemplate, listWorkflowTemplates } from '../../case-api.js';
import {
  EmptyState,
  ErrorAlert,
  LoadingMessage,
  type ErrorNotice,
} from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { workflowPath } from '../../routes.js';
import { toErrorNotice } from '../error-notice.js';
import { formatDateTime } from '../cases/case-format.js';

function NewTemplateForm({ onCancel }: { onCancel: () => void }) {
  const id = useId();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (name.trim().length === 0) {
      setNameError('Enter a template name.');
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const created = await createWorkflowTemplate({
        name: name.trim(),
        description: description.trim(),
        definition: STARTER_WORKFLOW_DEFINITION,
      });
      void navigate(workflowPath(created.id), {
        state: { notice: 'Template created as draft version 1. Adjust it, then publish.' },
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WORKFLOW_TEMPLATE_NAME_EXISTS') {
        setNameError(error.message);
      } else {
        setNotice(toErrorNotice(error, 'Could not create the template'));
      }
      setSaving(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle>New workflow template</SheetTitle>
        <SheetDescription>
          The template starts from a typical annual-return workflow and checklist that you can edit
          before publishing.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 px-4">
        {notice !== null && <ErrorAlert notice={notice} />}
        <Field data-invalid={nameError !== null}>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={120}
            aria-invalid={nameError !== null}
            aria-describedby={nameError === null ? undefined : `${id}-name-error`}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          <FieldError id={`${id}-name-error`}>{nameError}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
          <Textarea
            id={`${id}-description`}
            value={description}
            maxLength={1000}
            aria-describedby={`${id}-description-help`}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <FieldDescription id={`${id}-description-help`}>
            Which services or clients this process suits.
          </FieldDescription>
        </Field>
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving} aria-busy={saving}>
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Create template
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Workflow and checklist templates (TD-302, TD-303). */
export function WorkflowsPage() {
  const headingId = useId();
  const [templates, setTemplates] = useState<readonly WorkflowTemplateSummary[] | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listWorkflowTemplates(controller.signal)
      .then((result) => {
        setTemplates(result.templates);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setTemplates([]);
          setNotice(toErrorNotice(error, 'Could not load workflow templates'));
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <section aria-labelledby={headingId}>
      <PageHeader
        id={headingId}
        title="Workflows"
        description="Reusable statuses, allowed transitions, and checklists. Cases keep the version they were opened with."
        actions={
          <Button
            type="button"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus aria-hidden="true" />
            New template
          </Button>
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {templates === null ? (
        <LoadingMessage>Loading workflow templates…</LoadingMessage>
      ) : (
        <Card className="py-0">
          {templates.length === 0 ? (
            <EmptyState title="No workflow templates yet">
              Create a template to define how cases move from intake to completion.
            </EmptyState>
          ) : (
            <Table>
              <TableCaption className="sr-only">Workflow templates</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Draft</TableHead>
                  <TableHead>Last changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <Link
                        to={workflowPath(template.id)}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {template.name}
                      </Link>
                      {template.description.length > 0 && (
                        <div className="max-w-80 truncate text-xs text-muted-foreground">
                          {template.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {template.latestPublished === null ? (
                        <span className="text-muted-foreground">Not yet</span>
                      ) : (
                        <Badge variant="success">
                          Version {template.latestPublished.versionNumber}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {template.draft === null ? (
                        '—'
                      ) : (
                        <Badge variant="warning">Version {template.draft.versionNumber}</Badge>
                      )}
                    </TableCell>
                    <TableCell>{formatDateTime(template.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}
      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          {creating && (
            <NewTemplateForm
              onCancel={() => {
                setCreating(false);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

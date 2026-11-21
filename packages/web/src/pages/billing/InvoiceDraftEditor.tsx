import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import {
  INVOICE_LIMITS,
  calculateInvoiceTotals,
  groupLinesByClient,
  parseMajorAmount,
  type BillableCase,
  type Invoice,
  type InvoiceItemInput,
} from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '../../api-client.js';
import { listBillableCases, updateInvoiceDraft } from '../../billing-api.js';
import { getClient } from '../../client-api.js';
import { ErrorAlert, type ErrorNotice } from '../../components/feedback.js';
import { toErrorNotice } from '../error-notice.js';
import { invoiceLineErrors, money, toMajorInput } from './billing-format.js';
import {
  CombinedLineFields,
  lineClientOptions,
  type LineClientOption,
} from './CombinedLineFields.js';

interface DraftLine {
  readonly key: number;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  /** Combined invoices (TD-511): who the line is for and its optional case; `''` for none. */
  readonly clientId: string;
  readonly caseId: string;
}

function linesOf(invoice: Invoice): DraftLine[] {
  return invoice.items.map((item, index) => ({
    key: index,
    description: item.description,
    quantity: String(item.quantity),
    unit: toMajorInput(item.unitAmountMinor),
    clientId: item.client?.id ?? '',
    caseId: item.case?.id ?? '',
  }));
}

/** Parses the form into the request shape, or reports which field is wrong. */
function parseLines(
  lines: readonly DraftLine[],
  combined: boolean,
): {
  items: InvoiceItemInput[];
  errors: ReadonlyMap<string, string>;
} {
  const errors = new Map<string, string>();
  const items: InvoiceItemInput[] = [];
  lines.forEach((line, index) => {
    if (combined && line.clientId === '') {
      errors.set(`c${String(index)}`, 'Choose who this line is for.');
    }
    const quantity = /^\d{1,6}$/u.test(line.quantity.trim()) ? Number(line.quantity) : Number.NaN;
    const unit = parseMajorAmount(line.unit);
    if (line.description.trim().length === 0) {
      errors.set(`d${String(index)}`, 'Enter a description.');
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.set(`q${String(index)}`, 'Use a whole quantity of at least 1.');
    }
    if (unit === null) {
      errors.set(`u${String(index)}`, 'Enter an amount such as 1,500.00.');
    }
    if (unit !== null && Number.isInteger(quantity)) {
      items.push({
        description: line.description.trim(),
        quantity,
        unitAmountMinor: unit,
        ...(combined && line.clientId !== '' ? { clientId: line.clientId } : {}),
        ...(combined && line.caseId !== '' ? { caseId: line.caseId } : {}),
      });
    }
  });
  return { items, errors };
}

/**
 * The group's clients and each line client's billable cases for a combined
 * draft (TD-511). Cases are loaded once per client as lines name them.
 */
function useCombinedOptions(invoice: Invoice, lines: readonly DraftLine[]) {
  const combined = invoice.billingMode === 'combined';
  const [clientOptions, setClientOptions] = useState<readonly LineClientOption[]>(() =>
    combined ? lineClientOptions(invoice.client, []) : [],
  );
  const [cases, setCases] = useState<ReadonlyMap<string, readonly BillableCase[]>>(new Map());
  const [loadNotice, setLoadNotice] = useState<ErrorNotice | null>(null);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (!combined) return;
    const controller = new AbortController();
    void getClient(invoice.client.id, controller.signal)
      .then((head) => {
        setClientOptions(lineClientOptions(head, head.groupMembers));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadNotice(toErrorNotice(error, 'Could not load the group members'));
        }
      });
    return () => {
      controller.abort();
    };
  }, [combined, invoice.client.id]);

  const clientIds = useMemo(
    () => [...new Set(lines.map((line) => line.clientId).filter((id) => id !== ''))],
    [lines],
  );
  useEffect(() => {
    if (!combined) return;
    for (const clientId of clientIds) {
      if (requested.current.has(clientId)) continue;
      requested.current.add(clientId);
      void listBillableCases(invoice.id, clientId)
        .then((list) => {
          setCases((current) => new Map(current).set(clientId, list.cases));
        })
        .catch((error: unknown) => {
          setCases((current) => new Map(current).set(clientId, []));
          setLoadNotice(toErrorNotice(error, 'Could not load the cases for a line'));
        });
    }
  }, [combined, clientIds, invoice.id]);

  return { combined, clientOptions, cases, loadNotice };
}

/**
 * Edits a draft: line items (add, remove, move up or down), discount, dates,
 * and notes. On a combined group invoice (TD-511) each line also names the
 * client it is for and an optional case. The totals shown are a preview from
 * the shared calculator; the server recomputes them and the browser never
 * sends a total.
 */
export function InvoiceDraftEditor({
  invoice,
  onSaved,
  onStale,
  onFinalize,
  lineErrors = null,
}: {
  invoice: Invoice;
  onSaved: (invoice: Invoice) => void;
  onStale: () => void;
  onFinalize: () => void;
  /** Line errors from a refused finalize (for example a client that left the group). */
  lineErrors?: ReadonlyMap<string, string> | null;
}) {
  const id = useId();
  const [lines, setLines] = useState<DraftLine[]>(() => linesOf(invoice));
  const [nextKey, setNextKey] = useState(lines.length);
  const [discount, setDiscount] = useState(toMajorInput(invoice.discountMinor));
  const [issueDate, setIssueDate] = useState(invoice.issueDate ?? '');
  const [dueDate, setDueDate] = useState(invoice.dueDate ?? '');
  const [notes, setNotes] = useState(invoice.notes);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Line errors the server returned; cleared by the next edit.
  const [serverErrors, setServerErrors] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (lineErrors !== null) setServerErrors(lineErrors);
  }, [lineErrors]);
  const lineError = (key: string): string | undefined =>
    (showErrors ? parsed.errors.get(key) : undefined) ?? serverErrors.get(key);

  const { combined, clientOptions, cases, loadNotice } = useCombinedOptions(invoice, lines);
  const parsed = useMemo(() => parseLines(lines, combined), [lines, combined]);
  const discountMinor = parseMajorAmount(discount);
  const preview = useMemo(
    () =>
      discountMinor === null || parsed.errors.size > 0
        ? null
        : calculateInvoiceTotals(parsed.items, discountMinor),
    [parsed, discountMinor],
  );
  const dateError =
    issueDate !== '' && dueDate !== '' && dueDate < issueDate
      ? 'The due date cannot be before the issue date.'
      : null;
  const discountError =
    discountMinor === null
      ? 'Enter an amount such as 500.00, or 0.'
      : preview !== null && !preview.ok && preview.field === 'discountMinor'
        ? preview.message
        : null;

  function change<T>(setter: (value: T) => void, value: T): void {
    setter(value);
    setDirty(true);
  }

  function edited(): void {
    setDirty(true);
    setServerErrors(new Map());
  }

  function updateLine(key: number, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    edited();
  }

  function move(index: number, by: -1 | 1): void {
    setLines((current) => {
      const target = index + by;
      const moved = current[index];
      const other = current[target];
      if (moved === undefined || other === undefined) return current;
      const next = [...current];
      next[index] = other;
      next[target] = moved;
      return next;
    });
    edited();
  }

  async function save(): Promise<Invoice | null> {
    setShowErrors(true);
    if (
      parsed.errors.size > 0 ||
      discountMinor === null ||
      discountError !== null ||
      dateError !== null ||
      !preview?.ok
    ) {
      return null;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await updateInvoiceDraft(
        invoice.id,
        {
          items: parsed.items,
          discountMinor,
          issueDate: issueDate === '' ? null : issueDate,
          dueDate: dueDate === '' ? null : dueDate,
          notes,
        },
        invoice.version,
      );
      setDirty(false);
      onSaved(saved);
      return saved;
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        onStale();
      } else {
        setNotice(toErrorNotice(error, 'Could not save the draft'));
        setServerErrors(invoiceLineErrors(error) ?? new Map());
      }
      return null;
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    void save();
  }

  const totals = preview?.ok === true ? preview.totals : null;
  const memberSubtotals =
    combined && totals !== null
      ? groupLinesByClient(
          parsed.items.map((item, index) => ({
            clientId: item.clientId ?? null,
            lineTotalMinor: totals.lineTotalsMinor[index] ?? 0,
          })),
        )
      : [];
  const clientLabel = (clientId: string): string =>
    clientOptions.find((option) => option.id === clientId)?.label.replace(/ · group head$/u, '') ??
    invoice.items.find((item) => item.client?.id === clientId)?.client?.displayName ??
    'Client';

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Edit draft invoice">
      {notice !== null && <ErrorAlert notice={notice} />}
      {loadNotice !== null && <ErrorAlert notice={loadNotice} />}
      {combined && (
        <p className="text-sm text-muted-foreground">
          A combined invoice to {invoice.client.displayName}. Choose who each line is for: the group
          head or one of its members. The invoice PDF groups the lines by client with a subtotal for
          each.
        </p>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>
            <h2 className="text-base font-semibold">Line items</h2>
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={lines.length >= INVOICE_LIMITS.itemsMax}
            onClick={() => {
              setLines((current) => [
                ...current,
                {
                  key: nextKey,
                  description: '',
                  quantity: '1',
                  unit: '0.00',
                  clientId: combined ? invoice.client.id : '',
                  caseId: '',
                },
              ]);
              setNextKey(nextKey + 1);
              edited();
            }}
          >
            <Plus aria-hidden="true" />
            Add line
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {lines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No line items yet. Add a line to describe the work being billed.
            </p>
          )}
          {lines.map((line, index) => {
            const position = String(index + 1);
            const descriptionError = lineError(`d${String(index)}`);
            const quantityError = lineError(`q${String(index)}`);
            const unitError = lineError(`u${String(index)}`);
            const clientError = lineError(`c${String(index)}`);
            const caseError = lineError(`k${String(index)}`);
            return (
              <fieldset
                key={line.key}
                className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_6rem_9rem_auto]"
              >
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Line {position}
                </legend>
                {combined && (
                  <CombinedLineFields
                    idPrefix={`${id}-${String(line.key)}`}
                    clientId={line.clientId}
                    caseId={line.caseId}
                    clientOptions={clientOptions}
                    cases={line.clientId === '' ? null : (cases.get(line.clientId) ?? null)}
                    clientError={clientError}
                    caseError={caseError}
                    onClientChange={(clientId) => {
                      updateLine(line.key, { clientId, caseId: '' });
                    }}
                    onCaseChange={(billableCase) => {
                      updateLine(
                        line.key,
                        billableCase === null
                          ? { caseId: '' }
                          : {
                              caseId: billableCase.id,
                              description: billableCase.description,
                              unit: toMajorInput(billableCase.unitAmountMinor),
                            },
                      );
                    }}
                  />
                )}
                <Field data-invalid={descriptionError !== undefined}>
                  <FieldLabel htmlFor={`${id}-d-${String(line.key)}`}>Description</FieldLabel>
                  <Input
                    id={`${id}-d-${String(line.key)}`}
                    value={line.description}
                    maxLength={INVOICE_LIMITS.descriptionMax}
                    aria-invalid={descriptionError !== undefined}
                    onChange={(event) => {
                      updateLine(line.key, { description: event.target.value });
                    }}
                  />
                  <FieldError>{descriptionError}</FieldError>
                </Field>
                <Field data-invalid={quantityError !== undefined}>
                  <FieldLabel htmlFor={`${id}-q-${String(line.key)}`}>Quantity</FieldLabel>
                  <Input
                    id={`${id}-q-${String(line.key)}`}
                    inputMode="numeric"
                    value={line.quantity}
                    aria-invalid={quantityError !== undefined}
                    onChange={(event) => {
                      updateLine(line.key, { quantity: event.target.value });
                    }}
                  />
                  <FieldError>{quantityError}</FieldError>
                </Field>
                <Field data-invalid={unitError !== undefined}>
                  <FieldLabel htmlFor={`${id}-u-${String(line.key)}`}>Unit amount (PKR)</FieldLabel>
                  <Input
                    id={`${id}-u-${String(line.key)}`}
                    inputMode="decimal"
                    value={line.unit}
                    aria-invalid={unitError !== undefined}
                    onChange={(event) => {
                      updateLine(line.key, { unit: event.target.value });
                    }}
                  />
                  <FieldError>{unitError}</FieldError>
                </Field>
                <div className="flex items-end gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move line ${position} up`}
                    disabled={index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move line ${position} down`}
                    disabled={index === lines.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove line ${position}`}
                    onClick={() => {
                      setLines((current) => current.filter((entry) => entry.key !== line.key));
                      edited();
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </fieldset>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Discount, dates, and notes</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field data-invalid={showErrors && discountError !== null}>
            <FieldLabel htmlFor={`${id}-discount`}>Discount (PKR)</FieldLabel>
            <Input
              id={`${id}-discount`}
              inputMode="decimal"
              value={discount}
              aria-invalid={showErrors && discountError !== null}
              onChange={(event) => {
                change(setDiscount, event.target.value);
              }}
            />
            <FieldError>{showErrors ? discountError : null}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-issue`}>Issue date</FieldLabel>
            <Input
              id={`${id}-issue`}
              type="date"
              value={issueDate}
              onChange={(event) => {
                change(setIssueDate, event.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Left empty, today is used when finalized.
            </p>
          </Field>
          <Field data-invalid={dateError !== null}>
            <FieldLabel htmlFor={`${id}-due`}>Due date</FieldLabel>
            <Input
              id={`${id}-due`}
              type="date"
              value={dueDate}
              aria-invalid={dateError !== null}
              onChange={(event) => {
                change(setDueDate, event.target.value);
              }}
            />
            <FieldError>{dateError}</FieldError>
          </Field>
          <Field className="sm:col-span-3">
            <FieldLabel htmlFor={`${id}-notes`}>Notes</FieldLabel>
            <Textarea
              id={`${id}-notes`}
              value={notes}
              maxLength={INVOICE_LIMITS.notesMax}
              onChange={(event) => {
                change(setNotes, event.target.value);
              }}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {memberSubtotals.length > 0 && (
            <dl
              aria-label="Subtotal by client"
              className="mb-3 grid max-w-sm gap-1 border-b pb-3 text-sm sm:ml-auto"
            >
              {memberSubtotals.map((group) => (
                <div key={group.clientId} className="flex justify-between gap-6">
                  <dt className="text-muted-foreground">{clientLabel(group.clientId)}</dt>
                  <dd>{money(group.subtotalMinor)}</dd>
                </div>
              ))}
            </dl>
          )}
          <dl aria-label="Invoice total preview" className="grid max-w-sm gap-1 text-sm sm:ml-auto">
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd>{totals === null ? '—' : money(totals.subtotalMinor)}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">Discount</dt>
              <dd>{totals === null ? '—' : money(totals.discountMinor)}</dd>
            </div>
            <div className="flex justify-between gap-6 border-t pt-1 text-base font-semibold">
              <dt>Total</dt>
              <dd>{totals === null ? '—' : money(totals.totalMinor)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground sm:text-right">
            A preview. The server recomputes the total when you save.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="submit" variant="outline" disabled={saving} aria-busy={saving}>
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
          Save draft
        </Button>
        <Button
          type="button"
          disabled={saving}
          onClick={() => {
            void (async () => {
              // Finalize acts on the saved draft, so save pending changes first.
              if (!dirty || (await save()) !== null) onFinalize();
            })();
          }}
        >
          Finalize…
        </Button>
      </div>
    </form>
  );
}

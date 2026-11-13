import { useId, useMemo, useState, type SyntheticEvent } from 'react';
import { ArrowDown, ArrowUp, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import {
  INVOICE_LIMITS,
  calculateInvoiceTotals,
  parseMajorAmount,
  type Invoice,
  type InvoiceItemInput,
} from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '../../api-client.js';
import { updateInvoiceDraft } from '../../billing-api.js';
import { ErrorAlert, type ErrorNotice } from '../../components/feedback.js';
import { toErrorNotice } from '../error-notice.js';
import { money, toMajorInput } from './billing-format.js';

interface DraftLine {
  readonly key: number;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
}

function linesOf(invoice: Invoice): DraftLine[] {
  return invoice.items.map((item, index) => ({
    key: index,
    description: item.description,
    quantity: String(item.quantity),
    unit: toMajorInput(item.unitAmountMinor),
  }));
}

/** Parses the form into the request shape, or reports which field is wrong. */
function parseLines(lines: readonly DraftLine[]): {
  items: InvoiceItemInput[];
  errors: ReadonlyMap<string, string>;
} {
  const errors = new Map<string, string>();
  const items: InvoiceItemInput[] = [];
  lines.forEach((line, index) => {
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
      items.push({ description: line.description.trim(), quantity, unitAmountMinor: unit });
    }
  });
  return { items, errors };
}

/**
 * Edits a draft: line items (add, remove, move up or down), discount, dates,
 * and notes. The totals shown are a preview from the shared calculator; the
 * server recomputes them and the browser never sends a total.
 */
export function InvoiceDraftEditor({
  invoice,
  onSaved,
  onStale,
  onFinalize,
}: {
  invoice: Invoice;
  onSaved: (invoice: Invoice) => void;
  onStale: () => void;
  onFinalize: () => void;
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

  const parsed = useMemo(() => parseLines(lines), [lines]);
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

  function updateLine(key: number, patch: Partial<DraftLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setDirty(true);
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
    setDirty(true);
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

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Edit draft invoice">
      {notice !== null && <ErrorAlert notice={notice} />}
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
                { key: nextKey, description: '', quantity: '1', unit: '0.00' },
              ]);
              setNextKey(nextKey + 1);
              setDirty(true);
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
            const descriptionError = showErrors
              ? parsed.errors.get(`d${String(index)}`)
              : undefined;
            const quantityError = showErrors ? parsed.errors.get(`q${String(index)}`) : undefined;
            const unitError = showErrors ? parsed.errors.get(`u${String(index)}`) : undefined;
            return (
              <fieldset
                key={line.key}
                className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_6rem_9rem_auto]"
              >
                <legend className="px-1 text-xs font-medium text-muted-foreground">
                  Line {position}
                </legend>
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
                      setDirty(true);
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

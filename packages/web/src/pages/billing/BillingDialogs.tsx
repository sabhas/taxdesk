import { useId, useState, type SyntheticEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  INVOICE_LIMITS,
  PAYMENT_METHODS,
  parseMajorAmount,
  type Invoice,
  type Payment,
  type PaymentMethod,
  type PaymentOutcome,
} from '@taxdesk/shared';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { finalizeInvoice, recordPayment, reversePayment, voidInvoice } from '../../billing-api.js';
import { ApiError, newRequestId } from '../../api-client.js';
import { ErrorAlert, type ErrorNotice } from '../../components/feedback.js';
import { toErrorNotice } from '../error-notice.js';
import { PAYMENT_METHOD_LABELS, money, toMajorInput } from './billing-format.js';

/**
 * Financial dialogs. Each form mounts only while its dialog is open, so the
 * idempotency key is created once per open and reused on every retry of that
 * submission: a lost response can never record a second entry.
 */

function localToday(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

interface SubmitState {
  readonly working: boolean;
  readonly notice: ErrorNotice | null;
}

function useSubmit() {
  const [key] = useState(() => newRequestId());
  const [state, setState] = useState<SubmitState>({ working: false, notice: null });
  async function run(
    action: (idempotencyKey: string) => Promise<void>,
    failureTitle: string,
  ): Promise<void> {
    setState({ working: true, notice: null });
    try {
      await action(key);
    } catch (error) {
      setState({ working: false, notice: toErrorNotice(error, failureTitle) });
      return;
    }
    setState({ working: false, notice: null });
  }
  return {
    ...state,
    run,
    setNotice: (notice: ErrorNotice | null) => {
      setState((s) => ({ ...s, notice }));
    },
  };
}

function Busy({ working }: { working: boolean }) {
  return working ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null;
}

// ---------------------------------------------------------------------------

export function FinalizeInvoiceDialog({
  invoice,
  open,
  onOpenChange,
  onFinalized,
  onError,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinalized: (invoice: Invoice) => void;
  onError: (error: unknown) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {open && (
          <FinalizeBody
            invoice={invoice}
            onCancel={() => {
              onOpenChange(false);
            }}
            onFinalized={onFinalized}
            onError={onError}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FinalizeBody({
  invoice,
  onCancel,
  onFinalized,
  onError,
}: {
  invoice: Invoice;
  onCancel: () => void;
  onFinalized: (invoice: Invoice) => void;
  onError: (error: unknown) => void;
}) {
  const submit = useSubmit();
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Finalize this invoice?</AlertDialogTitle>
        <AlertDialogDescription>
          The invoice total of {money(invoice.totalMinor)} gets its permanent number and its line
          items are frozen. To correct it afterwards you must void it and issue a new one.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {submit.notice !== null && <ErrorAlert notice={submit.notice} />}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={submit.working}>Cancel</AlertDialogCancel>
        <Button
          type="button"
          disabled={submit.working}
          aria-busy={submit.working}
          onClick={() => {
            void submit.run(async (key) => {
              try {
                onFinalized(await finalizeInvoice(invoice.id, invoice.version, key));
              } catch (error) {
                // A stale version is handled by the page (refresh and review).
                if (error instanceof ApiError && error.status === 412) {
                  onError(error);
                  onCancel();
                }
                throw error;
              }
            }, 'Could not finalize the invoice');
          }}
        >
          <Busy working={submit.working} />
          Finalize invoice
        </Button>
      </AlertDialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------

export function RecordPaymentDialog({
  invoice,
  open,
  onOpenChange,
  onRecorded,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: (outcome: PaymentOutcome) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {open && (
          <RecordPaymentBody
            invoice={invoice}
            onCancel={() => {
              onOpenChange(false);
            }}
            onRecorded={onRecorded}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RecordPaymentBody({
  invoice,
  onCancel,
  onRecorded,
}: {
  invoice: Invoice;
  onCancel: () => void;
  onRecorded: (outcome: PaymentOutcome) => void;
}) {
  const id = useId();
  const submit = useSubmit();
  const [amount, setAmount] = useState(toMajorInput(invoice.outstandingMinor));
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [receivedOn, setReceivedOn] = useState(localToday());
  const [reference, setReference] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    const minor = parseMajorAmount(amount);
    if (minor === null || minor <= 0) {
      setAmountError('Enter an amount above zero, such as 1,500.00.');
      return;
    }
    if (minor > invoice.outstandingMinor) {
      setAmountError(`The amount is more than the ${money(invoice.outstandingMinor)} outstanding.`);
      return;
    }
    setAmountError(null);
    void submit.run(async (key) => {
      const outcome = await recordPayment(
        invoice.id,
        { amountMinor: minor, method, receivedOn, reference },
        key,
      );
      onRecorded(outcome);
    }, 'Could not record the payment');
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <AlertDialogHeader>
        <AlertDialogTitle>Record a payment</AlertDialogTitle>
        <AlertDialogDescription>
          {money(invoice.outstandingMinor)} is outstanding. A receipt number is issued for every
          payment, and a recorded payment can only be corrected by a reversal.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {submit.notice !== null && <ErrorAlert notice={submit.notice} />}
      <Field data-invalid={amountError !== null}>
        <FieldLabel htmlFor={`${id}-amount`}>Amount (PKR)</FieldLabel>
        <Input
          id={`${id}-amount`}
          inputMode="decimal"
          value={amount}
          aria-invalid={amountError !== null}
          aria-describedby={amountError === null ? undefined : `${id}-amount-error`}
          onChange={(event) => {
            setAmount(event.target.value);
            setAmountError(null);
          }}
        />
        <FieldError id={`${id}-amount-error`}>{amountError}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-method`}>Method</FieldLabel>
        <NativeSelect
          id={`${id}-method`}
          value={method}
          onChange={(event) => {
            setMethod(event.target.value as PaymentMethod);
          }}
        >
          {PAYMENT_METHODS.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {PAYMENT_METHOD_LABELS[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-date`}>Received on</FieldLabel>
        <Input
          id={`${id}-date`}
          type="date"
          value={receivedOn}
          onChange={(event) => {
            setReceivedOn(event.target.value);
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-reference`}>Reference (optional)</FieldLabel>
        <Input
          id={`${id}-reference`}
          value={reference}
          maxLength={INVOICE_LIMITS.referenceMax}
          onChange={(event) => {
            setReference(event.target.value);
          }}
        />
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={submit.working} onClick={onCancel}>
          Cancel
        </AlertDialogCancel>
        <Button type="submit" disabled={submit.working} aria-busy={submit.working}>
          <Busy working={submit.working} />
          Record payment
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function ReversePaymentDialog({
  payment,
  open,
  onOpenChange,
  onReversed,
}: {
  payment: Payment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReversed: (outcome: PaymentOutcome) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {open && payment !== null && (
          <ReverseBody
            payment={payment}
            onCancel={() => {
              onOpenChange(false);
            }}
            onReversed={onReversed}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReverseBody({
  payment,
  onCancel,
  onReversed,
}: {
  payment: Payment;
  onCancel: () => void;
  onReversed: (outcome: PaymentOutcome) => void;
}) {
  const id = useId();
  const submit = useSubmit();
  const unreversed = payment.amountMinor - payment.reversedMinor;
  const [amount, setAmount] = useState(toMajorInput(unreversed));
  const [reason, setReason] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    const minor = parseMajorAmount(amount);
    const amountProblem =
      minor === null || minor <= 0
        ? 'Enter an amount above zero.'
        : minor > unreversed
          ? `The amount is more than the ${money(unreversed)} not yet reversed.`
          : null;
    const reasonProblem = reason.trim().length === 0 ? 'Enter the reason for the reversal.' : null;
    setAmountError(amountProblem);
    setReasonError(reasonProblem);
    if (amountProblem !== null || reasonProblem !== null || minor === null) {
      return;
    }
    void submit.run(async (key) => {
      onReversed(
        await reversePayment(payment.id, { amountMinor: minor, reason: reason.trim() }, key),
      );
    }, 'Could not reverse the payment');
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <AlertDialogHeader>
        <AlertDialogTitle>Reverse payment {payment.receiptNumber}</AlertDialogTitle>
        <AlertDialogDescription>
          The payment stays in the history. A linked reversal entry lowers the amount paid by the
          amount you enter, up to {money(unreversed)}.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {submit.notice !== null && <ErrorAlert notice={submit.notice} />}
      <Field data-invalid={amountError !== null}>
        <FieldLabel htmlFor={`${id}-amount`}>Amount to reverse (PKR)</FieldLabel>
        <Input
          id={`${id}-amount`}
          inputMode="decimal"
          value={amount}
          aria-invalid={amountError !== null}
          aria-describedby={amountError === null ? undefined : `${id}-amount-error`}
          onChange={(event) => {
            setAmount(event.target.value);
            setAmountError(null);
          }}
        />
        <FieldError id={`${id}-amount-error`}>{amountError}</FieldError>
      </Field>
      <Field data-invalid={reasonError !== null}>
        <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={INVOICE_LIMITS.reasonMax}
          aria-invalid={reasonError !== null}
          aria-describedby={reasonError === null ? undefined : `${id}-reason-error`}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(null);
          }}
        />
        <FieldError id={`${id}-reason-error`}>{reasonError}</FieldError>
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={submit.working} onClick={onCancel}>
          Cancel
        </AlertDialogCancel>
        <Button
          type="submit"
          variant="destructive"
          disabled={submit.working}
          aria-busy={submit.working}
        >
          <Busy working={submit.working} />
          Reverse payment
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function VoidInvoiceDialog({
  invoice,
  open,
  onOpenChange,
  onVoided,
  onError,
}: {
  invoice: Invoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVoided: (invoice: Invoice) => void;
  onError: (error: unknown) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {open && (
          <VoidBody
            invoice={invoice}
            onCancel={() => {
              onOpenChange(false);
            }}
            onVoided={onVoided}
            onError={onError}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function VoidBody({
  invoice,
  onCancel,
  onVoided,
  onError,
}: {
  invoice: Invoice;
  onCancel: () => void;
  onVoided: (invoice: Invoice) => void;
  onError: (error: unknown) => void;
}) {
  const id = useId();
  const submit = useSubmit();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  function onSubmit(event: SyntheticEvent): void {
    event.preventDefault();
    if (reason.trim().length === 0) {
      setReasonError('Enter the reason for voiding this invoice.');
      return;
    }
    void submit.run(async (key) => {
      try {
        onVoided(
          await voidInvoice(
            invoice.id,
            invoice.version,
            { reason: reason.trim(), confirm: true },
            key,
          ),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 412) {
          onError(error);
          onCancel();
        }
        throw error;
      }
    }, 'Could not void the invoice');
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <AlertDialogHeader>
        <AlertDialogTitle>Void this invoice?</AlertDialogTitle>
        <AlertDialogDescription>
          Voiding is permanent. The invoice
          {invoice.invoiceNumber === null ? '' : ` ${invoice.invoiceNumber}`} stays visible with its
          history, but it can no longer receive payments. It cannot be voided while payments are
          recorded: reverse them first.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {submit.notice !== null && <ErrorAlert notice={submit.notice} />}
      <Field data-invalid={reasonError !== null}>
        <FieldLabel htmlFor={`${id}-reason`}>Reason</FieldLabel>
        <Textarea
          id={`${id}-reason`}
          value={reason}
          maxLength={INVOICE_LIMITS.reasonMax}
          aria-invalid={reasonError !== null}
          aria-describedby={reasonError === null ? undefined : `${id}-reason-error`}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(null);
          }}
        />
        <FieldError id={`${id}-reason-error`}>{reasonError}</FieldError>
      </Field>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={submit.working} onClick={onCancel}>
          Cancel
        </AlertDialogCancel>
        <Button
          type="submit"
          variant="destructive"
          disabled={submit.working}
          aria-busy={submit.working}
        >
          <Busy working={submit.working} />
          Void invoice
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

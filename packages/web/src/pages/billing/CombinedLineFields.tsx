import { Link } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import type { BillableCase, ClientGroupRef } from '@taxdesk/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { invoicePath } from '../../routes.js';
import { INVOICE_STATUS_LABELS } from './billing-format.js';

/** A client a combined-invoice line can be for: the group head or a member. */
export interface LineClientOption {
  readonly id: string;
  readonly label: string;
}

/** The head first, then its active members; archived members cannot be billed. */
export function lineClientOptions(
  head: { readonly id: string; readonly clientCode: string; readonly displayName: string },
  members: readonly ClientGroupRef[],
): LineClientOption[] {
  return [
    { id: head.id, label: `${head.displayName} (${head.clientCode}) · group head` },
    ...members
      .filter((member) => member.state === 'active')
      .map((member) => ({ id: member.id, label: `${member.displayName} (${member.clientCode})` })),
  ];
}

/**
 * The "Billed for" and "Case" fields of one combined-invoice line (TD-511),
 * with the duplicate-billing warning. Choosing a case fills the line from its
 * service and fee (the parent editor does that); the warning never blocks,
 * because partial and follow-up billing are legitimate.
 */
export function CombinedLineFields({
  idPrefix,
  clientId,
  caseId,
  clientOptions,
  cases,
  clientError,
  caseError,
  onClientChange,
  onCaseChange,
}: {
  idPrefix: string;
  clientId: string;
  caseId: string;
  clientOptions: readonly LineClientOption[];
  /** `null` while the client's cases are loading or when none is chosen. */
  cases: readonly BillableCase[] | null;
  clientError: string | undefined;
  caseError: string | undefined;
  onClientChange: (clientId: string) => void;
  onCaseChange: (billableCase: BillableCase | null) => void;
}) {
  const chosen = cases?.find((entry) => entry.id === caseId) ?? null;
  const known = clientOptions.some((option) => option.id === clientId);
  return (
    <div className="grid gap-3 sm:col-span-4 sm:grid-cols-2">
      <Field data-invalid={clientError !== undefined}>
        <FieldLabel htmlFor={`${idPrefix}-client`}>Billed for</FieldLabel>
        <NativeSelect
          id={`${idPrefix}-client`}
          className="w-full"
          value={clientId}
          aria-invalid={clientError !== undefined}
          onChange={(event) => {
            onClientChange(event.target.value);
          }}
        >
          <NativeSelectOption value="">Choose a client</NativeSelectOption>
          {clientId !== '' && !known && (
            <NativeSelectOption value={clientId}>Client no longer in this group</NativeSelectOption>
          )}
          {clientOptions.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldError>{clientError}</FieldError>
      </Field>
      <Field data-invalid={caseError !== undefined}>
        <FieldLabel htmlFor={`${idPrefix}-case`}>Case (optional)</FieldLabel>
        <NativeSelect
          id={`${idPrefix}-case`}
          className="w-full"
          value={caseId}
          aria-invalid={caseError !== undefined}
          disabled={clientId === '' || cases === null}
          onChange={(event) => {
            const value = event.target.value;
            onCaseChange(cases?.find((entry) => entry.id === value) ?? null);
          }}
        >
          <NativeSelectOption value="">
            {clientId !== '' && cases === null ? 'Loading cases…' : 'No case'}
          </NativeSelectOption>
          {caseId !== '' && cases !== null && chosen === null && (
            <NativeSelectOption value={caseId}>Current case</NativeSelectOption>
          )}
          {(cases ?? []).map((entry) => (
            <NativeSelectOption key={entry.id} value={entry.id}>
              {entry.caseCode} · {entry.serviceName} {entry.taxYear}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldError>{caseError}</FieldError>
      </Field>
      {chosen !== null && chosen.otherInvoices.length > 0 && (
        <Alert variant="warning" className="sm:col-span-2">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <span>
              {chosen.caseCode} is already on{' '}
              {chosen.otherInvoices.map((other, index) => (
                <span key={other.id}>
                  {index > 0 && ', '}
                  <Link
                    to={invoicePath(other.id)}
                    className="underline underline-offset-4"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {other.invoiceNumber ?? 'a draft invoice'}
                  </Link>{' '}
                  ({INVOICE_STATUS_LABELS[other.status].toLowerCase()})
                </span>
              ))}
              . You can still bill it here, for example for follow-up work.
            </span>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

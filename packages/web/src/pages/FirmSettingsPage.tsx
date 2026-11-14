import { useEffect, useState, type SubmitEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { FIRM_SETTING_LIMITS, type FirmSettings } from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { getFirmSettings, updateFirmSettings } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import {
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  SuccessNotice,
  type ErrorNotice,
} from '../components/feedback.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { toErrorNotice } from './error-notice.js';

const MIB = 1024 * 1024;
const COMMON_TIMEZONES = ['Asia/Karachi', 'UTC', 'Asia/Dubai', 'Europe/London', 'America/New_York'];

export function FirmSettingsPage() {
  const { can, state } = useSession();
  const [settings, setSettings] = useState<FirmSettings | null>(null);
  const [firmName, setFirmName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Karachi');
  const [currency, setCurrency] = useState('PKR');
  const [invoicePrefix, setInvoicePrefix] = useState('INV');
  const [receiptPrefix, setReceiptPrefix] = useState('RCP');
  const [uploadMib, setUploadMib] = useState('250');
  const [dueSoonDays, setDueSoonDays] = useState('7');
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getFirmSettings(controller.signal)
      .then((result) => {
        if (active) {
          setSettings(result);
          setFirmName(result.firmName);
          setTimezone(result.timezone);
          setCurrency(result.currency);
          setInvoicePrefix(result.invoicePrefix);
          setReceiptPrefix(result.receiptPrefix);
          setUploadMib(String(result.documentMaxUploadBytes / MIB));
          setDueSoonDays(String(result.dueSoonDays));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setNotice(toErrorNotice(error, 'Could not load firm settings'));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  if (state.status !== 'authenticated' || !can('firm.settings.read')) {
    return <PermissionDenied />;
  }

  async function save(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (settings === null) {
      return;
    }
    setSaving(true);
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await updateFirmSettings(
        {
          firmName,
          timezone,
          currency: currency as FirmSettings['currency'],
          invoicePrefix: invoicePrefix.trim(),
          receiptPrefix: receiptPrefix.trim(),
          documentMaxUploadBytes: Math.round(Number(uploadMib) * MIB),
          dueSoonDays: Number(dueSoonDays),
        },
        settings.version,
      );
      setSettings(updated);
      setSuccess('Firm settings saved.');
    } catch (error) {
      // Field errors, if any, are listed inside the notice.
      setNotice(toErrorNotice(error, 'Could not save firm settings'));
    } finally {
      setSaving(false);
    }
  }

  if (settings === null) {
    return (
      <section aria-labelledby="firm-heading">
        <PageHeader id="firm-heading" title="Firm settings" />
        {notice !== null ? (
          <ErrorAlert notice={notice} />
        ) : (
          <LoadingMessage>Loading firm settings…</LoadingMessage>
        )}
      </section>
    );
  }

  const canManage = can('firm.settings.manage');

  return (
    <section aria-labelledby="firm-heading">
      <PageHeader
        id="firm-heading"
        title="Firm settings"
        description={`Dates and times are presented in this timezone. Version ${String(settings.version)}.`}
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      <Card className="max-w-2xl">
        <form onSubmit={(event) => void save(event)}>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="firm-name">Firm name</FieldLabel>
                <Input
                  id="firm-name"
                  required
                  maxLength={160}
                  disabled={!canManage}
                  value={firmName}
                  onChange={(event) => {
                    setFirmName(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timezone">Timezone</FieldLabel>
                <Input
                  id="timezone"
                  required
                  list="timezone-options"
                  disabled={!canManage}
                  aria-describedby="timezone-help"
                  value={timezone}
                  onChange={(event) => {
                    setTimezone(event.target.value);
                  }}
                />
                <datalist id="timezone-options">
                  {COMMON_TIMEZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                <FieldDescription id="timezone-help">
                  An IANA timezone name, for example Asia/Karachi.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="currency">Currency</FieldLabel>
                <NativeSelect
                  id="currency"
                  disabled={!canManage}
                  aria-describedby="currency-help"
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                  }}
                >
                  {FIRM_SETTING_LIMITS.supportedCurrencies.map((code) => (
                    <NativeSelectOption key={code} value={code}>
                      {code}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <FieldDescription id="currency-help">
                  Invoices are issued in this currency. More currencies are not yet supported.
                </FieldDescription>
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="invoice-prefix">Invoice number prefix</FieldLabel>
                  <Input
                    id="invoice-prefix"
                    required
                    maxLength={6}
                    pattern="[A-Z]{2,6}"
                    disabled={!canManage}
                    aria-describedby="prefix-help"
                    value={invoicePrefix}
                    onChange={(event) => {
                      setInvoicePrefix(event.target.value.toUpperCase());
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="receipt-prefix">Receipt number prefix</FieldLabel>
                  <Input
                    id="receipt-prefix"
                    required
                    maxLength={6}
                    pattern="[A-Z]{2,6}"
                    disabled={!canManage}
                    aria-describedby="prefix-help"
                    value={receiptPrefix}
                    onChange={(event) => {
                      setReceiptPrefix(event.target.value.toUpperCase());
                    }}
                  />
                </Field>
              </div>
              <FieldDescription id="prefix-help">
                2 to 6 capital letters. A new prefix applies to numbers issued from now on; numbers
                already issued never change.
              </FieldDescription>
              <Field>
                <FieldLabel htmlFor="upload-limit">Document size limit (MiB)</FieldLabel>
                <Input
                  id="upload-limit"
                  type="number"
                  required
                  inputMode="numeric"
                  min={FIRM_SETTING_LIMITS.documentMaxUploadBytesMin / MIB}
                  max={FIRM_SETTING_LIMITS.documentMaxUploadBytesMax / MIB}
                  disabled={!canManage}
                  aria-describedby="upload-help"
                  value={uploadMib}
                  onChange={(event) => {
                    setUploadMib(event.target.value);
                  }}
                />
                <FieldDescription id="upload-help">
                  The largest file staff can upload, from{' '}
                  {FIRM_SETTING_LIMITS.documentMaxUploadBytesMin / MIB} to{' '}
                  {FIRM_SETTING_LIMITS.documentMaxUploadBytesMax / MIB} MiB.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="due-soon-days">Dashboard due-soon window (days)</FieldLabel>
                <Input
                  id="due-soon-days"
                  type="number"
                  required
                  inputMode="numeric"
                  min={FIRM_SETTING_LIMITS.dueSoonDaysMin}
                  max={FIRM_SETTING_LIMITS.dueSoonDaysMax}
                  disabled={!canManage}
                  aria-describedby="due-soon-help"
                  value={dueSoonDays}
                  onChange={(event) => {
                    setDueSoonDays(event.target.value);
                  }}
                />
                <FieldDescription id="due-soon-help">
                  Open cases due within this many days count as due soon on the dashboard and in the
                  case queues.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="mt-6 justify-end">
            {canManage ? (
              <Button type="submit" disabled={saving} aria-busy={saving}>
                {saving && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                {saving ? 'Saving…' : 'Save settings'}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Your role can view but not change firm settings.
              </p>
            )}
          </CardFooter>
        </form>
      </Card>
    </section>
  );
}

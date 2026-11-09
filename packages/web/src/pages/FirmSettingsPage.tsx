import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { FirmSettings } from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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

const COMMON_TIMEZONES = ['Asia/Karachi', 'UTC', 'Asia/Dubai', 'Europe/London', 'America/New_York'];

export function FirmSettingsPage() {
  const { can, state } = useSession();
  const [settings, setSettings] = useState<FirmSettings | null>(null);
  const [firmName, setFirmName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Karachi');
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

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (settings === null) {
      return;
    }
    setSaving(true);
    setNotice(null);
    setSuccess(null);
    try {
      const updated = await updateFirmSettings({ firmName, timezone }, settings.version);
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

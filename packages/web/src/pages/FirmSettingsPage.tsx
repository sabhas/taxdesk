import { useEffect, useState, type FormEvent } from 'react';
import type { FirmSettings } from '@taxdesk/shared';
import { getFirmSettings, updateFirmSettings } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import {
  ErrorAlert,
  LoadingMessage,
  PermissionDenied,
  SuccessNotice,
  type ErrorNotice,
} from '../components/feedback.js';
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
      const next = toErrorNotice(error, 'Could not save firm settings');
      setNotice(next);
      if (next.fields !== undefined) {
        // Field errors are already displayed with the notice.
      }
    } finally {
      setSaving(false);
    }
  }

  if (settings === null) {
    return (
      <section aria-labelledby="firm-heading">
        <h1 id="firm-heading">Firm settings</h1>
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
      <h1 id="firm-heading">Firm settings</h1>
      <p className="muted small">
        Dates and times are presented in this timezone. Version {settings.version}.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      <form onSubmit={(event) => void save(event)}>
        <div className="field">
          <label htmlFor="firm-name">Firm name</label>
          <input
            id="firm-name"
            required
            maxLength={160}
            disabled={!canManage}
            value={firmName}
            onChange={(event) => {
              setFirmName(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="timezone">Timezone</label>
          <input
            id="timezone"
            required
            list="timezone-options"
            disabled={!canManage}
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
        </div>
        {canManage ? (
          <button type="submit" disabled={saving} aria-busy={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        ) : (
          <p className="muted">Your role can view but not change firm settings.</p>
        )}
      </form>
    </section>
  );
}

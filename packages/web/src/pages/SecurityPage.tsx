import { useState, type FormEvent } from 'react';
import { disableMfa, regenerateRecoveryCodes } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import { ErrorAlert, SuccessNotice, type ErrorNotice } from '../components/feedback.js';
import { toErrorNotice } from './error-notice.js';

export function SecurityPage() {
  const { state, refresh } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [regenerated, setRegenerated] = useState<readonly string[] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'regenerate' | 'disable' | null>(null);

  if (state.status !== 'authenticated') {
    return null;
  }

  async function regenerate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting('regenerate');
    setNotice(null);
    setSuccess(null);
    try {
      const result = await regenerateRecoveryCodes({ password, code });
      setRegenerated(result.recoveryCodes);
      setSuccess('New recovery codes generated. The previous codes no longer work.');
      setPassword('');
      setCode('');
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not regenerate recovery codes'));
    } finally {
      setSubmitting(null);
    }
  }

  async function disable(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!confirmDisable) {
      setNotice({
        title: 'Confirm MFA removal',
        message: 'Tick the confirmation box before disabling multi-factor authentication.',
      });
      return;
    }
    setSubmitting('disable');
    setNotice(null);
    setSuccess(null);
    try {
      await disableMfa({ password, code });
      refresh();
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not disable MFA'));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section aria-labelledby="security-heading">
      <h1 id="security-heading">Security</h1>
      <p>
        Multi-factor authentication is{' '}
        {state.session.user.mfaEnrolled ? <strong>enabled</strong> : <strong>not enabled</strong>}.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {regenerated !== null && (
        <section aria-labelledby="codes-heading">
          <h2 id="codes-heading">New recovery codes</h2>
          <p>These codes are shown once. Store them securely.</p>
          <ul className="recovery-codes" aria-label="New recovery codes">
            {regenerated.map((recoveryCode) => (
              <li key={recoveryCode}>
                <code>{recoveryCode}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="card-grid">
        <section className="card" aria-labelledby="regenerate-heading">
          <h2 id="regenerate-heading">Regenerate recovery codes</h2>
          <p className="muted small">
            Confirm your password and a current authenticator code. Other sessions are signed out.
          </p>
          <form onSubmit={(event) => void regenerate(event)}>
            <div className="field">
              <label htmlFor="regen-password">Password</label>
              <input
                id="regen-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="regen-code">Authenticator code</label>
              <input
                id="regen-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/gu, ''));
                }}
              />
            </div>
            <button
              type="submit"
              disabled={submitting !== null}
              aria-busy={submitting === 'regenerate'}
            >
              Regenerate codes
            </button>
          </form>
        </section>
        <section className="card" aria-labelledby="disable-heading">
          <h2 id="disable-heading">Disable multi-factor authentication</h2>
          <p className="muted small">
            After disabling MFA you must set it up again before you can use firm records.
          </p>
          <form onSubmit={(event) => void disable(event)}>
            <div className="field">
              <label htmlFor="disable-password">Password</label>
              <input
                id="disable-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="disable-code">Authenticator code</label>
              <input
                id="disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/gu, ''));
                }}
              />
            </div>
            <div className="checkbox">
              <input
                id="confirm-disable"
                type="checkbox"
                checked={confirmDisable}
                onChange={(event) => {
                  setConfirmDisable(event.target.checked);
                }}
              />
              <label htmlFor="confirm-disable">
                I understand that MFA will be removed from my account.
              </label>
            </div>
            <button
              type="submit"
              disabled={submitting !== null}
              aria-busy={submitting === 'disable'}
            >
              Disable MFA
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}

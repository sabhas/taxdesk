import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MfaEnrollment } from '@taxdesk/shared';
import { confirmMfa, enrollMfa } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import { ErrorAlert, LoadingMessage, type ErrorNotice } from '../components/feedback.js';
import { toErrorNotice } from './error-notice.js';

export function MfaEnrollmentPage({ onComplete }: { onComplete: () => void }) {
  const { signOut } = useSession();
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void enrollMfa()
      .then((result) => {
        if (active) {
          setEnrollment(result);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        // An already-enrolled session simply needs a refresh.
        if (error instanceof Error && 'code' in error && error.code === 'MFA_ALREADY_ENROLLED') {
          onComplete();
          return;
        }
        setNotice(toErrorNotice(error, 'Could not start MFA setup'));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [onComplete]);

  const confirm = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitting(true);
      setNotice(null);
      try {
        const result = await confirmMfa(code);
        setRecoveryCodes(result.recoveryCodes);
      } catch (error) {
        setNotice(toErrorNotice(error, 'Could not confirm MFA'));
      } finally {
        setSubmitting(false);
      }
    },
    [code],
  );

  if (recoveryCodes !== null) {
    return (
      <main>
        <h1>Save your recovery codes</h1>
        <p>
          These codes are shown once. Store them somewhere safe. Each code can be used one time if
          you lose access to your authenticator app.
        </p>
        <ul className="recovery-codes" aria-label="Recovery codes">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>
              <code>{recoveryCode}</code>
            </li>
          ))}
        </ul>
        <button type="button" onClick={onComplete}>
          I have saved these codes
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Set up multi-factor authentication</h1>
      <p>
        TaxDesk requires an authenticator app before you can use firm records. Add the secret below
        to your app, then enter the six-digit code.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      {enrollment === null ? (
        <LoadingMessage>Starting secure enrollment…</LoadingMessage>
      ) : (
        <section aria-labelledby="mfa-secret-heading">
          <h2 id="mfa-secret-heading">Authenticator setup</h2>
          <p className="muted small">{enrollment.issuer}</p>
          <p>
            Manual secret: <code className="secret-value">{enrollment.secret}</code>
          </p>
          <details>
            <summary>Use a setup link instead</summary>
            <p className="break-all">
              <code>{enrollment.otpauthUri}</code>
            </p>
          </details>
          <form onSubmit={(event) => void confirm(event)}>
            <div className="field">
              <label htmlFor="enrollment-code">Six-digit code</label>
              <input
                id="enrollment-code"
                name="code"
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
            <button type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? 'Confirming…' : 'Enable MFA'}
            </button>
          </form>
        </section>
      )}
      <button type="button" className="secondary" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}

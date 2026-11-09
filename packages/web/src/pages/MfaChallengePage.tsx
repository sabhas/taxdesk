import { useState, type FormEvent } from 'react';
import type { CurrentSession } from '@taxdesk/shared';
import { completeMfaChallenge, completeMfaRecovery } from '../auth-client.js';
import { ErrorAlert, type ErrorNotice } from '../components/feedback.js';
import type { MfaChallengeState } from './LoginPage.js';
import { toErrorNotice } from './error-notice.js';

export function MfaChallengePage({
  challenge,
  onAuthenticated,
  onStartOver,
}: {
  challenge: MfaChallengeState;
  onAuthenticated: (session: CurrentSession) => void;
  onStartOver: () => void;
}) {
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const response =
        mode === 'totp'
          ? await completeMfaChallenge({ challengeToken: challenge.token, code })
          : await completeMfaRecovery({
              challengeToken: challenge.token,
              recoveryCode,
            });
      if (response.status === 'authenticated') {
        onAuthenticated(response.session);
        return;
      }
      onStartOver();
    } catch (error) {
      setNotice(toErrorNotice(error, 'Verification failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Multi-factor verification</h1>
      <p className="muted">
        Challenge expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      <div className="segmented" role="group" aria-label="Verification method">
        <button
          type="button"
          className={mode === 'totp' ? 'active' : ''}
          aria-pressed={mode === 'totp'}
          onClick={() => {
            setMode('totp');
          }}
        >
          Authenticator code
        </button>
        <button
          type="button"
          className={mode === 'recovery' ? 'active' : ''}
          aria-pressed={mode === 'recovery'}
          onClick={() => {
            setMode('recovery');
          }}
        >
          Recovery code
        </button>
      </div>
      <form onSubmit={(event) => void handleSubmit(event)}>
        {mode === 'totp' ? (
          <div className="field">
            <label htmlFor="mfa-code">Six-digit code</label>
            <input
              id="mfa-code"
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
        ) : (
          <div className="field">
            <label htmlFor="recovery-code">Recovery code</label>
            <input
              id="recovery-code"
              name="recoveryCode"
              autoComplete="one-time-code"
              required
              value={recoveryCode}
              onChange={(event) => {
                setRecoveryCode(event.target.value);
              }}
            />
            <p className="muted small">Each recovery code works once.</p>
          </div>
        )}
        <div className="button-row">
          <button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" className="secondary" onClick={onStartOver}>
            Start over
          </button>
        </div>
      </form>
    </main>
  );
}

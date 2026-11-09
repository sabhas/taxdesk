import { useCallback, useState, type FormEvent } from 'react';
import type { CurrentSession } from '@taxdesk/shared';
import { login } from '../auth-client.js';
import { ErrorAlert, type ErrorNotice } from '../components/feedback.js';
import { TurnstileWidget } from '../components/TurnstileWidget.js';
import { toErrorNotice } from './error-notice.js';

export interface MfaChallengeState {
  readonly token: string;
  readonly expiresAt: string;
}

export function LoginPage({
  expired,
  onAuthenticated,
  onMfaRequired,
}: {
  expired: boolean;
  onAuthenticated: (session: CurrentSession) => void;
  onMfaRequired: (challenge: MfaChallengeState) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');

  const onToken = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (siteKey !== null && turnstileToken.length === 0) {
      setNotice({
        title: 'Verification required',
        message: 'Complete the verification below, then sign in again.',
      });
      return;
    }

    setSubmitting(true);
    setNotice(null);
    try {
      const response = await login({
        email,
        password,
        ...(turnstileToken.length === 0 ? {} : { turnstileToken }),
      });
      if (response.status === 'authenticated' || response.status === 'mfa_enrollment_required') {
        onAuthenticated(response.session);
        return;
      }
      if (response.status === 'mfa_required') {
        onMfaRequired({ token: response.challengeToken, expiresAt: response.expiresAt });
        return;
      }
      setSiteKey(response.siteKey);
      setNotice({
        title: 'Verification required',
        message: 'Complete the verification below, then sign in again.',
      });
    } catch (error) {
      setTurnstileToken('');
      setNotice(toErrorNotice(error, 'Sign-in failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Sign in to TaxDesk</h1>
      {expired && (
        <p role="status" className="notice-panel">
          Your session expired. Sign in again to continue.
        </p>
      )}
      {notice !== null && <ErrorAlert notice={notice} />}
      <form onSubmit={(event) => void handleSubmit(event)} aria-describedby="login-help">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
        {siteKey !== null && <TurnstileWidget siteKey={siteKey} onToken={onToken} />}
        <p id="login-help" className="muted small">
          Accounts are created by a firm administrator. There is no public registration.
        </p>
        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

import { useCallback, useState, type FormEvent } from 'react';
import type { CurrentSession } from '@taxdesk/shared';
import { login } from '../auth-client.js';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ErrorAlert, InfoNotice, type ErrorNotice } from '../components/feedback.js';
import { AuthHeading, AuthLayout } from '../components/layout/AuthLayout.js';
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
  const [username, setUsername] = useState('');
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
        username,
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
    <AuthLayout>
      <AuthHeading
        title="Sign in to TaxDesk"
        description="Use the username your firm administrator gave you."
      />
      {expired && (
        <InfoNotice tone="warning">Your session expired. Sign in again to continue.</InfoNotice>
      )}
      {notice !== null && <ErrorAlert notice={notice} />}
      <form onSubmit={(event) => void handleSubmit(event)} aria-describedby="login-help">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="username">Username</FieldLabel>
            <Input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
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
          </Field>
          {siteKey !== null && <TurnstileWidget siteKey={siteKey} onToken={onToken} />}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <p id="login-help" className="text-center text-sm text-muted-foreground">
            Accounts are created by a firm administrator. There is no public registration.
          </p>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}

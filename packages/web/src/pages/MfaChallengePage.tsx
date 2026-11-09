import { useState, type SubmitEvent } from 'react';
import { KeyRound, LoaderCircle, Smartphone } from 'lucide-react';
import type { CurrentSession } from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { completeMfaChallenge, completeMfaRecovery } from '../auth-client.js';
import { ErrorAlert, type ErrorNotice } from '../components/feedback.js';
import { AuthHeading, AuthLayout } from '../components/layout/AuthLayout.js';
import type { MfaChallengeState } from './LoginPage.js';
import { toErrorNotice } from './error-notice.js';

type Mode = 'totp' | 'recovery';

export function MfaChallengePage({
  challenge,
  onAuthenticated,
  onStartOver,
}: {
  challenge: MfaChallengeState;
  onAuthenticated: (session: CurrentSession) => void;
  onStartOver: () => void;
}) {
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
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
    <AuthLayout>
      <AuthHeading
        title="Multi-factor verification"
        description={`This step expires at ${new Date(challenge.expiresAt).toLocaleTimeString()}.`}
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      <ToggleGroup
        aria-label="Verification method"
        variant="outline"
        className="mb-5 w-full *:flex-1"
        value={[mode]}
        onValueChange={(values: unknown[]) => {
          const next = values[0];
          if (next === 'totp' || next === 'recovery') {
            setMode(next);
          }
        }}
      >
        <ToggleGroupItem value="totp">
          <Smartphone aria-hidden="true" />
          Authenticator code
        </ToggleGroupItem>
        <ToggleGroupItem value="recovery">
          <KeyRound aria-hidden="true" />
          Recovery code
        </ToggleGroupItem>
      </ToggleGroup>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <FieldGroup>
          {mode === 'totp' ? (
            <Field>
              <FieldLabel htmlFor="mfa-code">Six-digit code</FieldLabel>
              <Input
                id="mfa-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="h-11 text-center font-mono text-lg tracking-[0.4em]"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/gu, ''));
                }}
              />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="recovery-code">Recovery code</FieldLabel>
              <Input
                id="recovery-code"
                name="recoveryCode"
                autoComplete="one-time-code"
                required
                aria-describedby="recovery-code-help"
                className="font-mono"
                value={recoveryCode}
                onChange={(event) => {
                  setRecoveryCode(event.target.value);
                }}
              />
              <FieldDescription id="recovery-code-help">
                Each recovery code works once.
              </FieldDescription>
            </Field>
          )}
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={submitting}
              aria-busy={submitting}
            >
              {submitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {submitting ? 'Verifying…' : 'Verify'}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={onStartOver}>
              Start over
            </Button>
          </div>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}

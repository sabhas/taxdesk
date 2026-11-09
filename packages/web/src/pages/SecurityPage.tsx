import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { disableMfa, regenerateRecoveryCodes } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import { ErrorAlert, SuccessNotice, type ErrorNotice } from '../components/feedback.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { RecoveryCodeList } from '../components/RecoveryCodeList.js';
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

  const credentialFields = (prefix: 'regen' | 'disable') => (
    <>
      <Field>
        <FieldLabel htmlFor={`${prefix}-password`}>Password</FieldLabel>
        <Input
          id={`${prefix}-password`}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-code`}>Authenticator code</FieldLabel>
        <Input
          id={`${prefix}-code`}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          className="font-mono tracking-[0.2em]"
          value={code}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/gu, ''));
          }}
        />
      </Field>
    </>
  );

  return (
    <section aria-labelledby="security-heading">
      <PageHeader
        id="security-heading"
        title="Security"
        description={
          <span className="inline-flex items-center gap-2">
            Multi-factor authentication is
            {state.session.user.mfaEnrolled ? (
              <Badge variant="success">enabled</Badge>
            ) : (
              <Badge variant="warning">not enabled</Badge>
            )}
          </span>
        }
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {success !== null && <SuccessNotice>{success}</SuccessNotice>}
      {regenerated !== null && (
        <section aria-labelledby="codes-heading" className="mb-6 space-y-3">
          <div>
            <h2 id="codes-heading" className="text-base font-semibold">
              New recovery codes
            </h2>
            <p className="text-sm text-muted-foreground">
              These codes are shown once. Store them securely.
            </p>
          </div>
          <RecoveryCodeList codes={regenerated} label="New recovery codes" />
        </section>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card aria-labelledby="regenerate-heading">
          <CardHeader>
            <CardTitle>
              <h2 id="regenerate-heading">Regenerate recovery codes</h2>
            </CardTitle>
            <CardDescription>
              Confirm your password and a current authenticator code. Other sessions are signed out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void regenerate(event)}>
              <FieldGroup>
                {credentialFields('regen')}
                <Button
                  type="submit"
                  className="self-start"
                  disabled={submitting !== null}
                  aria-busy={submitting === 'regenerate'}
                >
                  {submitting === 'regenerate' && (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  )}
                  Regenerate codes
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <Card aria-labelledby="disable-heading" className="ring-destructive/25">
          <CardHeader>
            <CardTitle>
              <h2 id="disable-heading">Disable multi-factor authentication</h2>
            </CardTitle>
            <CardDescription>
              After disabling MFA you must set it up again before you can use firm records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void disable(event)}>
              <FieldGroup>
                {credentialFields('disable')}
                <div className="flex items-start gap-2.5">
                  <input
                    id="confirm-disable"
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                    checked={confirmDisable}
                    onChange={(event) => {
                      setConfirmDisable(event.target.checked);
                    }}
                  />
                  <label htmlFor="confirm-disable" className="text-sm">
                    I understand that MFA will be removed from my account.
                  </label>
                </div>
                <Button
                  type="submit"
                  variant="destructive"
                  className="self-start"
                  disabled={submitting !== null}
                  aria-busy={submitting === 'disable'}
                >
                  {submitting === 'disable' && (
                    <LoaderCircle aria-hidden="true" className="animate-spin" />
                  )}
                  Disable MFA
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

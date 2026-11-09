import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, LoaderCircle } from 'lucide-react';
import type { MfaEnrollment } from '@taxdesk/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { confirmMfa, enrollMfa } from '../auth-client.js';
import { useSession } from '../session/session-context.js';
import { ErrorAlert, LoadingMessage, type ErrorNotice } from '../components/feedback.js';
import { AuthHeading, AuthLayout } from '../components/layout/AuthLayout.js';
import { RecoveryCodeList } from '../components/RecoveryCodeList.js';
import { toErrorNotice } from './error-notice.js';
import { QrCode } from '../components/QrCode.js';

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
      <AuthLayout width="wide">
        <AuthHeading
          title="Save your recovery codes"
          description="These codes are shown once. Store them somewhere safe. Each code can be used one time if you lose access to your authenticator app."
        />
        <RecoveryCodeList codes={recoveryCodes} label="Recovery codes" />
        <Button type="button" size="lg" className="mt-6" onClick={onComplete}>
          I have saved these codes
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout width="wide">
      <AuthHeading
        title="Set up multi-factor authentication"
        description="TaxDesk requires an authenticator app before you can use firm records."
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {enrollment === null ? (
        notice === null && <LoadingMessage>Starting secure enrollment…</LoadingMessage>
      ) : (
        <Card>
          <CardContent>
            <section aria-labelledby="mfa-secret-heading">
              <h2 id="mfa-secret-heading" className="sr-only">
                Authenticator setup
              </h2>
              <div className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
                <div className="flex flex-col items-center gap-2">
                  <div className="rounded-lg border bg-white p-2 leading-none">
                    <QrCode
                      value={enrollment.otpauthUri}
                      size={176}
                      label={`QR code that adds TaxDesk to your authenticator app for ${enrollment.issuer}`}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{enrollment.issuer}</p>
                </div>
                <div className="min-w-0 space-y-4 text-sm">
                  <ol className="list-decimal space-y-1.5 pl-5">
                    <li>Open your authenticator app and choose to add an account.</li>
                    <li>Scan this QR code with the app&apos;s camera.</li>
                    <li>Enter the six-digit code the app shows.</li>
                  </ol>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">
                      Can&apos;t scan? Enter this secret instead:
                    </p>
                    <SecretValue value={enrollment.secret} />
                  </div>
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer rounded-sm hover:text-foreground">
                      Use a setup link instead
                    </summary>
                    <p className="mt-2 break-all">
                      <code>{enrollment.otpauthUri}</code>
                    </p>
                  </details>
                  <p className="text-xs text-muted-foreground">
                    Keep this screen private: the QR code contains your secret.
                  </p>
                </div>
              </div>
              <form onSubmit={(event) => void confirm(event)} className="mt-6 border-t pt-6">
                <FieldGroup className="sm:flex-row sm:items-end">
                  <Field className="sm:max-w-56">
                    <FieldLabel htmlFor="enrollment-code">Six-digit code</FieldLabel>
                    <Input
                      id="enrollment-code"
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      className="font-mono tracking-[0.3em]"
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value.replace(/\D/gu, ''));
                      }}
                    />
                  </Field>
                  <Button type="submit" disabled={submitting} aria-busy={submitting}>
                    {submitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
                    {submitting ? 'Confirming…' : 'Enable MFA'}
                  </Button>
                </FieldGroup>
              </form>
            </section>
          </CardContent>
        </Card>
      )}
      <Button type="button" variant="ghost" className="mt-4" onClick={() => void signOut()}>
        Sign out
      </Button>
    </AuthLayout>
  );
}

function SecretValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-1.5 break-all">{value}</code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={copied ? 'Secret copied' : 'Copy secret'}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
            },
            () => {
              setCopied(false);
            },
          );
        }}
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  );
}

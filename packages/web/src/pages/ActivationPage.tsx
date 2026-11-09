import { useState, type SubmitEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { activate } from '../auth-client.js';
import { ErrorAlert, SuccessNotice, type ErrorNotice } from '../components/feedback.js';
import { AuthHeading, AuthLayout } from '../components/layout/AuthLayout.js';
import { toErrorNotice } from './error-notice.js';

export function ActivationPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [complete, setComplete] = useState(false);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (password !== confirmation) {
      setNotice({ title: 'Passwords do not match', message: 'Enter the same password twice.' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await activate({ token, password });
      setComplete(true);
    } catch (error) {
      setNotice(toErrorNotice(error, 'Could not activate the account'));
    } finally {
      setSubmitting(false);
    }
  }

  if (complete) {
    return (
      <AuthLayout>
        <AuthHeading title="Account activated" />
        <SuccessNotice>Your password is set. You can now sign in.</SuccessNotice>
        <Button type="button" size="lg" className="w-full" onClick={onDone}>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading
        title="Activate your TaxDesk account"
        description="The link works once and expires 30 minutes after it was created."
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      <form onSubmit={(event) => void handleSubmit(event)}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="new-password">New password</FieldLabel>
            <Input
              id="new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              aria-describedby="new-password-help"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <FieldDescription id="new-password-help">At least 12 characters.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
            />
          </Field>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting && <LoaderCircle aria-hidden="true" className="animate-spin" />}
            {submitting ? 'Activating…' : 'Activate account'}
          </Button>
        </FieldGroup>
      </form>
    </AuthLayout>
  );
}

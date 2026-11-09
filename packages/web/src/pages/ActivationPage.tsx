import { useState, type FormEvent } from 'react';
import { activate } from '../auth-client.js';
import { ErrorAlert, SuccessNotice, type ErrorNotice } from '../components/feedback.js';
import { toErrorNotice } from './error-notice.js';

export function ActivationPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const [complete, setComplete] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
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
      <main>
        <h1>Account activated</h1>
        <SuccessNotice>Your password is set. You can now sign in.</SuccessNotice>
        <button type="button" onClick={onDone}>
          Go to sign in
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>Activate your TaxDesk account</h1>
      <p>
        Choose a password with at least 12 characters. The link works once and expires after 30
        minutes.
      </p>
      {notice !== null && <ErrorAlert notice={notice} />}
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="confirm-password">Confirm password</label>
          <input
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
        </div>
        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Activating…' : 'Activate account'}
        </button>
      </form>
    </main>
  );
}

import type { ReactNode } from 'react';
import type { FieldError } from '@taxdesk/shared';

export interface ErrorNotice {
  readonly title: string;
  readonly message: string;
  readonly requestId?: string | undefined;
  readonly fields?: readonly FieldError[] | undefined;
}

export function ErrorAlert({ notice }: { notice: ErrorNotice }) {
  return (
    <section role="alert" className="error-panel" aria-labelledby="error-heading">
      <h2 id="error-heading">{notice.title}</h2>
      <p>{notice.message}</p>
      {notice.fields !== undefined && notice.fields.length > 0 && (
        <ul>
          {notice.fields.map((field) => (
            <li key={`${field.field}:${field.message}`}>
              <strong>{field.field}:</strong> {field.message}
            </li>
          ))}
        </ul>
      )}
      {notice.requestId !== undefined && (
        <p>
          Reference ID: <code>{notice.requestId}</code>
        </p>
      )}
    </section>
  );
}

export function LoadingMessage({ children }: { children: ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="muted">
      {children}
    </p>
  );
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="success-panel">
      {children}
    </p>
  );
}

export function PermissionDenied() {
  return (
    <section aria-labelledby="permission-heading" className="error-panel">
      <h2 id="permission-heading">You do not have permission</h2>
      <p>Your role does not include access to this area. Ask an administrator if you need it.</p>
    </section>
  );
}

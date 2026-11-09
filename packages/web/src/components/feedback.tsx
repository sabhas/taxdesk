import { useId, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, LoaderCircle, ShieldX } from 'lucide-react';
import type { FieldError } from '@taxdesk/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export interface ErrorNotice {
  readonly title: string;
  readonly message: string;
  readonly requestId?: string | undefined;
  readonly fields?: readonly FieldError[] | undefined;
}

/** A failed action or request. Announced immediately (role="alert"). */
export function ErrorAlert({ notice }: { notice: ErrorNotice }) {
  const headingId = useId();
  return (
    <Alert variant="destructive" aria-labelledby={headingId} className="mb-5">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>
        <h2 id={headingId} className="text-sm font-semibold">
          {notice.title}
        </h2>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{notice.message}</p>
        {notice.fields !== undefined && notice.fields.length > 0 && (
          <ul className="list-disc pl-4">
            {notice.fields.map((field) => (
              <li key={`${field.field}:${field.message}`}>
                <strong>{field.field}:</strong> {field.message}
              </li>
            ))}
          </ul>
        )}
        {notice.requestId !== undefined && (
          <p className="text-xs">
            Reference ID: <code>{notice.requestId}</code>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Inline progress text with a spinner; announced politely. */
export function LoadingMessage({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
    >
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      {children}
    </p>
  );
}

/** Confirms an action that succeeded; announced politely. */
export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <Alert variant="success" role="status" aria-live="polite" className="mb-5">
      <CircleCheck aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** Neutral or cautionary information, e.g. "Your session expired". */
export function InfoNotice({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'warning';
}) {
  return (
    <Alert variant={tone} role="status" className="mb-5">
      <Info aria-hidden="true" />
      <AlertDescription className={tone === 'warning' ? undefined : 'text-foreground'}>
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** Shown when the signed-in role lacks a permission for the current view. */
export function PermissionDenied() {
  return (
    <section
      aria-labelledby="permission-heading"
      className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center"
    >
      <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-destructive-subtle text-destructive">
        <ShieldX aria-hidden="true" className="size-5" />
      </span>
      <h2 id="permission-heading" className="text-base font-semibold">
        You do not have permission
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Your role does not include access to this area. Ask an administrator if you need it.
      </p>
    </section>
  );
}

/** An empty list: says what is missing and, where possible, what to do next. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children !== undefined && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

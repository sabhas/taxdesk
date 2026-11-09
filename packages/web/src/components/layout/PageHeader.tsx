import type { ReactNode } from 'react';

/**
 * Top of every signed-in page: one h1, an optional one-line description, and
 * the page's primary actions aligned to the right on wide screens.
 */
export function PageHeader({
  id,
  title,
  description,
  actions,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 id={id} className="text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description !== undefined && (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}

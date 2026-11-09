import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Wordmark } from './BrandMark.js';

/**
 * Layout for every screen shown before the signed-in app: sign-in, MFA,
 * activation, and session loading/error states. An ink panel with ledger
 * rules carries the brand on wide screens; the form sits on paper.
 */
export function AuthLayout({
  children,
  width = 'narrow',
}: {
  children: ReactNode;
  width?: 'narrow' | 'wide';
}) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside
        aria-hidden="true"
        className="ledger-rules relative hidden flex-col justify-between bg-sidebar py-10 pr-10 pl-16 text-sidebar-foreground lg:flex"
      >
        <Wordmark inverted />
        <div className="max-w-sm space-y-3">
          <p className="text-2xl leading-snug font-medium text-balance">
            Client cases, documents and billing for the firm, kept in one place.
          </p>
          <p className="text-sm text-sidebar-muted">
            Staff accounts are created by a firm administrator.
          </p>
        </div>
      </aside>
      <main
        id="main-content"
        className="flex flex-col items-center justify-center px-4 py-10 sm:px-8"
      >
        <div className={cn('w-full', width === 'narrow' ? 'max-w-sm' : 'max-w-2xl')}>
          <Wordmark className="mb-8 lg:hidden" />
          {children}
        </div>
      </main>
    </div>
  );
}

/** Heading block used at the top of each auth screen. */
export function AuthHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="mb-6 space-y-1.5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description !== undefined && (
        <div className="text-sm text-muted-foreground">{description}</div>
      )}
    </div>
  );
}

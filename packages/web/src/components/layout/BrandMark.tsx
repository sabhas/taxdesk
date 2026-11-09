import { cn } from '@/lib/utils';

/**
 * TaxDesk mark: a ledger page with ruled lines and a closing rule, drawn
 * inline so it needs no image request and inherits `currentColor`.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      className={cn('size-8 shrink-0', className)}
    >
      <rect x="1" y="1" width="30" height="30" rx="7" className="fill-primary" />
      <path
        d="M9 10.5h14"
        className="stroke-primary-foreground"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M10.5 18.5l4 4 7.5-8.5"
        className="stroke-sidebar-primary"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function Wordmark({
  className,
  inverted = false,
}: {
  className?: string;
  inverted?: boolean;
}) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <BrandMark />
      <span
        className={cn(
          'text-lg font-semibold tracking-tight',
          inverted ? 'text-sidebar-foreground' : 'text-foreground',
        )}
      >
        TaxDesk
      </span>
    </span>
  );
}

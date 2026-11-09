import { Link } from 'react-router';
import { SearchX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '../components/layout/PageHeader.js';
import { ROUTE_PATHS } from '../routes.js';

/** Any signed-in URL that matches no route. */
export function NotFoundPage() {
  return (
    <section aria-labelledby="not-found-heading">
      <PageHeader
        id="not-found-heading"
        title="Page not found"
        description="This address does not match a page in TaxDesk."
      />
      <div className="flex flex-col items-center rounded-xl border border-dashed bg-card px-6 py-14 text-center">
        <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <SearchX aria-hidden="true" className="size-5" />
        </span>
        <p className="max-w-sm text-sm text-muted-foreground">
          Check the link you followed, or use the navigation to find what you need.
        </p>
        <Link to={ROUTE_PATHS.dashboard} className={buttonVariants({ className: 'mt-5' })}>
          Go to the dashboard
        </Link>
      </div>
    </section>
  );
}

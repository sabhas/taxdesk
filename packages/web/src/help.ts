import { ROUTE_PATHS } from './routes.js';

/**
 * TD-806: the staff help bundle, built from `docs/training/` and served by the
 * Pages Function at `/help/` to signed-in sessions only.
 */
export const HELP_HOME = '/help/';

/**
 * The guide page for each signed-in screen, matched by path prefix. The most
 * specific prefix comes first. A test checks every page and anchor exists.
 */
export const HELP_TOPICS: readonly (readonly [prefix: string, page: string])[] = [
  [ROUTE_PATHS.security, 'staff/getting-started.html#security-page'],
  [ROUTE_PATHS.users, 'staff/administration.html#users'],
  [ROUTE_PATHS.firmSettings, 'staff/administration.html#firm-settings'],
  [ROUTE_PATHS.audit, 'staff/administration.html#audit'],
  [ROUTE_PATHS.storage, 'staff/administration.html#storage'],
  [ROUTE_PATHS.clients, 'staff/clients.html'],
  [ROUTE_PATHS.cases, 'staff/cases.html'],
  [ROUTE_PATHS.invoices, 'staff/billing.html'],
  [ROUTE_PATHS.reports, 'staff/dashboard-reports.html#reports'],
  [ROUTE_PATHS.services, 'staff/services-workflows.html'],
  [ROUTE_PATHS.workflows, 'staff/services-workflows.html'],
  [ROUTE_PATHS.imports, 'staff/data-import.html'],
];

const DASHBOARD_TOPIC = 'staff/dashboard-reports.html#dashboard';

/** The help URL for the screen at `pathname`, or the help home when none fits. */
export function helpPathFor(pathname: string): string {
  if (pathname === ROUTE_PATHS.dashboard) {
    return HELP_HOME + DASHBOARD_TOPIC;
  }
  for (const [prefix, page] of HELP_TOPICS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return HELP_HOME + page;
    }
  }
  return HELP_HOME;
}

const RETURN_PATH = /^\/help(?:\/[A-Za-z0-9._/-]*)?(?:\?[A-Za-z0-9=&._%-]*)?$/u;

/**
 * Reads the `returnTo` the help gate adds when it sends a signed-out visitor to
 * sign in. Only a same-origin `/help` path is accepted, so the parameter can
 * never redirect anywhere else.
 */
export function helpReturnPath(search: string): string | null {
  const value = new URLSearchParams(search).get('returnTo');
  if (value === null || !RETURN_PATH.test(value) || value.includes('..') || value.includes('//')) {
    return null;
  }
  return value;
}

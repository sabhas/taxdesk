import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ROLE_DEFINITIONS, type DashboardCount, type DashboardSummary } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { ErrorAlert, LoadingMessage, type ErrorNotice } from '../components/feedback.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { getDashboardSummary } from '../report-api.js';
import { useSession } from '../session/session-context.js';
import { money } from './billing/billing-format.js';
import { formatDate } from './cases/case-format.js';
import { toErrorNotice } from './error-notice.js';

function StatusRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-right text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * A figure and the list or report that returns exactly those rows. The server
 * supplies the link, so what you open always reconciles with the number.
 */
function Stat({
  label,
  count,
  detail,
  tone,
}: {
  label: string;
  count: DashboardCount | { count: number; href: string };
  detail?: string;
  tone?: 'warning';
}) {
  return (
    <li>
      <Link
        to={count.href}
        className={cn(
          'flex h-full flex-col gap-1 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        )}
      >
        <span className="text-sm text-muted-foreground">{label}</span>
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums',
            tone === 'warning' && count.count > 0 && 'text-destructive',
          )}
        >
          {count.count}
          <span className="sr-only"> {count.count === 1 ? 'case' : 'cases'}</span>
        </span>
        {detail !== undefined && <span className="text-xs text-muted-foreground">{detail}</span>}
      </Link>
    </li>
  );
}

function StatGrid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {children}
    </ul>
  );
}

function SectionCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card aria-labelledby={id} className="mb-5">
      <CardHeader>
        <CardTitle>
          <h2 id={id}>{title}</h2>
        </CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function WorkSection({
  work,
  dueSoonDays,
}: {
  work: NonNullable<DashboardSummary['work']>;
  dueSoonDays: number;
}) {
  return (
    <SectionCard
      id="work-heading"
      title="Cases that need attention"
      description="Counts cover the cases you can see. Select a figure to open the matching list."
    >
      <StatGrid label="Case figures">
        <Stat label="Assigned to me" count={work.assigned} />
        <Stat label="Overdue" count={work.overdue} tone="warning" />
        <Stat label={`Due within ${String(dueSoonDays)} days`} count={work.dueSoon} />
        <Stat label="With checklist gaps" count={work.checklistGaps} detail="Among my cases" />
      </StatGrid>
      <h3 className="mt-5 mb-2 text-sm font-medium">Filing progress</h3>
      <StatGrid label="Filing progress">
        <Stat label="In progress" count={work.filing.inProgress} />
        <Stat label="Filed" count={work.filing.filed} />
        <Stat label="Completed" count={work.filing.completed} />
      </StatGrid>
    </SectionCard>
  );
}

function ManagementSection({
  management,
}: {
  management: NonNullable<DashboardSummary['management']>;
}) {
  return (
    <SectionCard
      id="management-heading"
      title="Team workload"
      description="Unassigned work, the review queue, and open cases per person."
    >
      <StatGrid label="Team figures">
        <Stat label="Unassigned" count={management.unassigned} tone="warning" />
        <Stat label="Open team cases" count={management.teamOpen} />
        <Stat label="Overdue team cases" count={management.teamOverdue} tone="warning" />
        <Stat label="Review queue" count={management.reviewQueue} detail="Items awaiting review" />
      </StatGrid>
      {management.workload.length > 0 && (
        <Table className="mt-5">
          <TableCaption className="sr-only">Open cases per staff member</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Staff member</TableHead>
              <TableHead scope="col" className="text-right">
                Open
              </TableHead>
              <TableHead scope="col" className="text-right">
                Overdue
              </TableHead>
              <TableHead scope="col" className="text-right">
                Due soon
              </TableHead>
              <TableHead scope="col" className="text-right">
                Reviewing
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {management.workload.map((row) => (
              <TableRow key={row.userId ?? 'unassigned'}>
                <TableCell>{row.displayName}</TableCell>
                {[row.open, row.overdue, row.dueSoon, row.reviewing].map((entry, index) => (
                  <TableCell key={index} className="text-right tabular-nums">
                    <Link to={entry.href} className="underline underline-offset-2">
                      {entry.count}
                      <span className="sr-only"> cases for {row.displayName}</span>
                    </Link>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

function BillingSection({ billing }: { billing: NonNullable<DashboardSummary['billing']> }) {
  return (
    <SectionCard
      id="billing-heading"
      title="Billing"
      description={`Collections for ${formatDate(billing.monthStart)} to ${formatDate(billing.monthEnd)}.`}
    >
      <ul aria-label="Billing figures" className="grid gap-3 sm:grid-cols-3">
        <li>
          <Link
            to={billing.unpaid.href}
            className="flex h-full flex-col gap-1 rounded-lg border bg-card p-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="text-sm text-muted-foreground">Unpaid invoices</span>
            <span className="text-2xl font-semibold tabular-nums">{billing.unpaid.count}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {money(billing.unpaid.amountMinor)} owed
            </span>
          </Link>
        </li>
        <li>
          <Link
            to={billing.overdue.href}
            className="flex h-full flex-col gap-1 rounded-lg border bg-card p-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="text-sm text-muted-foreground">Overdue invoices</span>
            <span
              className={cn(
                'text-2xl font-semibold tabular-nums',
                billing.overdue.count > 0 && 'text-destructive',
              )}
            >
              {billing.overdue.count}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {money(billing.overdue.amountMinor)} past due
            </span>
          </Link>
        </li>
        <li>
          <Link
            to={billing.collected.href}
            className="flex h-full flex-col gap-1 rounded-lg border bg-card p-4 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="text-sm text-muted-foreground">Collected this month</span>
            <span className="text-2xl font-semibold tabular-nums">
              {money(billing.collected.netMinor)}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {money(billing.collected.receivedMinor)} received,{' '}
              {money(billing.collected.reversedMinor)} reversed
            </span>
          </Link>
        </li>
      </ul>
    </SectionCard>
  );
}

export function DashboardPage() {
  const { state } = useSession();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [notice, setNotice] = useState<ErrorNotice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getDashboardSummary(controller.signal)
      .then(setSummary)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setNotice(toErrorNotice(error, 'Could not load the dashboard'));
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  if (state.status !== 'authenticated') {
    return null;
  }
  const session = state.session;
  const roleNames = session.roles.map((role) => ROLE_DEFINITIONS[role].name).join(', ');
  const empty =
    summary !== null &&
    summary.work === null &&
    summary.management === null &&
    summary.billing === null;

  return (
    <section aria-labelledby="dashboard-heading">
      <PageHeader
        id="dashboard-heading"
        title={`Welcome, ${session.user.displayName}`}
        description={`You are signed in as ${roleNames || 'a staff user'}.${summary === null ? '' : ` Today is ${formatDate(summary.today)}.`}`}
      />
      {notice !== null && <ErrorAlert notice={notice} />}
      {summary === null ? (
        notice === null && <LoadingMessage>Loading your dashboard…</LoadingMessage>
      ) : (
        <>
          {summary.work !== null && (
            <WorkSection work={summary.work} dueSoonDays={summary.dueSoonDays} />
          )}
          {summary.management !== null && <ManagementSection management={summary.management} />}
          {summary.billing !== null && <BillingSection billing={summary.billing} />}
          {empty && (
            <p className="mb-5 text-sm text-muted-foreground">
              Your role has no case or billing figures. Use the navigation to open your work.
            </p>
          )}
        </>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card aria-labelledby="security-status-heading">
          <CardHeader>
            <CardTitle>
              <h2 id="security-status-heading">Account security</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <StatusRow term="Multi-factor authentication">
                {session.user.mfaEnrolled ? (
                  <Badge variant="success">Enabled</Badge>
                ) : (
                  <Badge variant="warning">Setup required</Badge>
                )}
              </StatusRow>
              <StatusRow term="Session verified">
                {session.session.mfaVerified ? 'Yes' : 'No'}
              </StatusRow>
              <StatusRow term="Idle session ends">
                {new Date(session.session.idleExpiresAt).toLocaleString()}
              </StatusRow>
              <StatusRow term="Absolute session ends">
                {new Date(session.session.absoluteExpiresAt).toLocaleString()}
              </StatusRow>
            </dl>
          </CardContent>
        </Card>
        <Card aria-labelledby="access-heading">
          <CardHeader>
            <CardTitle>
              <h2 id="access-heading">Your access</h2>
            </CardTitle>
            <CardDescription>
              Navigation reflects these permissions; the API enforces them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-1.5">
              {session.permissions.map((permission) => (
                <li key={permission}>
                  <Badge variant="secondary" className="font-mono font-normal">
                    {permission}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

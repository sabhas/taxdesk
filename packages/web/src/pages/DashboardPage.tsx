import type { ReactNode } from 'react';
import { ROLE_DEFINITIONS } from '@taxdesk/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '../components/layout/PageHeader.js';
import { useSession } from '../session/session-context.js';

function StatusRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-right text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export function DashboardPage() {
  const { state } = useSession();
  if (state.status !== 'authenticated') {
    return null;
  }
  const session = state.session;
  const roleNames = session.roles.map((role) => ROLE_DEFINITIONS[role].name).join(', ');

  return (
    <section aria-labelledby="dashboard-heading">
      <PageHeader
        id="dashboard-heading"
        title={`Welcome, ${session.user.displayName}`}
        description={`You are signed in as ${roleNames || 'a staff user'}.`}
      />
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

import { useSession } from '../session/session-context.js';

const ROLE_NAMES: Record<string, string> = {
  administrator: 'Administrator',
  manager: 'Manager',
  consultant: 'Consultant',
  billing: 'Billing',
  read_only: 'Read-only',
};

export function DashboardPage() {
  const { state } = useSession();
  if (state.status !== 'authenticated') {
    return null;
  }
  const session = state.session;
  return (
    <section aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading">Welcome, {session.user.displayName}</h1>
      <p>
        You are signed in as{' '}
        {session.roles.map((role) => ROLE_NAMES[role] ?? role).join(', ') || 'a staff user'}.
      </p>
      <div className="card-grid">
        <section className="card" aria-labelledby="security-status-heading">
          <h2 id="security-status-heading">Account security</h2>
          <dl>
            <dt>Multi-factor authentication</dt>
            <dd>{session.user.mfaEnrolled ? 'Enabled' : 'Setup required'}</dd>
            <dt>Session verified</dt>
            <dd>{session.session.mfaVerified ? 'Yes' : 'No'}</dd>
            <dt>Idle session ends</dt>
            <dd>{new Date(session.session.idleExpiresAt).toLocaleString()}</dd>
            <dt>Absolute session ends</dt>
            <dd>{new Date(session.session.absoluteExpiresAt).toLocaleString()}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="access-heading">
          <h2 id="access-heading">Your access</h2>
          <p className="muted small">
            Navigation reflects these permissions; the API enforces them.
          </p>
          <ul className="permission-list">
            {session.permissions.map((permission) => (
              <li key={permission}>
                <code>{permission}</code>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

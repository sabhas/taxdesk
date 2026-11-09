import type { ReactNode } from 'react';
import type { RoleKey } from '@taxdesk/shared';
import { useSession } from '../session/session-context.js';

export type View = 'dashboard' | 'security' | 'users' | 'firm' | 'audit';

const ROLE_LABELS: Record<RoleKey, string> = {
  administrator: 'Administrator',
  manager: 'Manager',
  consultant: 'Consultant',
  billing: 'Billing',
  read_only: 'Read-only',
};

const NAV_ITEMS: readonly {
  view: View;
  label: string;
  permission?: 'users.manage' | 'firm.settings.read' | 'audit.read';
}[] = [
  { view: 'dashboard', label: 'Dashboard' },
  { view: 'security', label: 'Security' },
  { view: 'users', label: 'Users', permission: 'users.manage' },
  { view: 'firm', label: 'Firm settings', permission: 'firm.settings.read' },
  { view: 'audit', label: 'Audit history', permission: 'audit.read' },
];

export function AppShell({
  view,
  onNavigate,
  children,
}: {
  view: View;
  onNavigate: (view: View) => void;
  children: ReactNode;
}) {
  const { state, can, signOut } = useSession();
  const session = state.status === 'authenticated' ? state.session : null;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <div>
          <p className="brand">TaxDesk</p>
          {session !== null && (
            <p className="muted small">
              {session.user.displayName} ·{' '}
              {session.roles.map((role) => ROLE_LABELS[role]).join(', ')}
            </p>
          )}
        </div>
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <nav aria-label="Primary" className="app-nav">
        {NAV_ITEMS.filter((item) => item.permission === undefined || can(item.permission)).map(
          (item) => (
            <button
              key={item.view}
              type="button"
              className={view === item.view ? 'nav-button active' : 'nav-button'}
              aria-current={view === item.view ? 'page' : undefined}
              onClick={() => {
                onNavigate(item.view);
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </nav>
      <main id="main-content">{children}</main>
    </div>
  );
}

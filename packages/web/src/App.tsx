import { useCallback, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import type { CurrentSession } from '@taxdesk/shared';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { Button } from '@/components/ui/button';
import { DocumentTitle } from '@/lib/document-title';
import { AppShell } from './components/AppShell.js';
import { ErrorAlert, LoadingMessage, PermissionDenied } from './components/feedback.js';
import { AuthHeading, AuthLayout } from './components/layout/AuthLayout.js';
import { ActivationPage } from './pages/ActivationPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { ClientDetailPage } from './pages/clients/ClientDetailPage.js';
import { ClientFormPage } from './pages/clients/ClientFormPage.js';
import { ClientsPage } from './pages/clients/ClientsPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FirmSettingsPage } from './pages/FirmSettingsPage.js';
import { LoginPage, type MfaChallengeState } from './pages/LoginPage.js';
import { MfaChallengePage } from './pages/MfaChallengePage.js';
import { MfaEnrollmentPage } from './pages/MfaEnrollmentPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { SecurityPage } from './pages/SecurityPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { NAV_ROUTES, ROUTE_PATHS } from './routes.js';
import { SessionProvider, useSession } from './session/session-context.js';

const PAGES: Readonly<Record<string, ReactNode>> = {
  [ROUTE_PATHS.dashboard]: <DashboardPage />,
  [ROUTE_PATHS.security]: <SecurityPage />,
  [ROUTE_PATHS.users]: <UsersPage />,
  [ROUTE_PATHS.firmSettings]: <FirmSettingsPage />,
  [ROUTE_PATHS.audit]: <AuditPage />,
  [ROUTE_PATHS.clients]: <ClientsPage />,
};

/**
 * Reads the one-time token from an activation link. The API builds these as
 * `/activate?token=…`; any path with a token is accepted, as before routing.
 */
function activationTokenFromLocation(): string | null {
  const parameters = new URLSearchParams(window.location.search);
  const token = parameters.get('token');
  return token !== null && token.length > 0 ? token : null;
}

function AppContent() {
  const { state, can, adopt, refresh } = useSession();
  const [challenge, setChallenge] = useState<MfaChallengeState | null>(null);
  const [activationToken, setActivationToken] = useState<string | null>(
    activationTokenFromLocation,
  );
  const navigate = useNavigate();

  const onAuthenticated = useCallback(
    (session: CurrentSession) => {
      adopt(session);
      setChallenge(null);
    },
    [adopt],
  );

  const onActivationDone = useCallback(() => {
    setActivationToken(null);
    // Drop the one-time token from the address bar and history entry.
    void navigate(ROUTE_PATHS.dashboard, { replace: true });
    refresh();
  }, [navigate, refresh]);

  const onMfaEnrollmentComplete = useCallback(() => {
    refresh();
  }, [refresh]);

  if (activationToken !== null) {
    return (
      <>
        <DocumentTitle title="Activate your account" />
        <ActivationPage token={activationToken} onDone={onActivationDone} />
      </>
    );
  }

  if (challenge !== null) {
    return (
      <>
        <DocumentTitle title="Verify sign-in" />
        <MfaChallengePage
          challenge={challenge}
          onAuthenticated={onAuthenticated}
          onStartOver={() => {
            setChallenge(null);
          }}
        />
      </>
    );
  }

  if (state.status === 'loading') {
    return (
      <AuthLayout>
        <DocumentTitle />
        <AuthHeading title="TaxDesk" />
        <LoadingMessage>Loading your session…</LoadingMessage>
      </AuthLayout>
    );
  }

  if (state.status === 'error') {
    return (
      <AuthLayout>
        <DocumentTitle />
        <AuthHeading title="TaxDesk" />
        <ErrorAlert
          notice={{
            title: 'TaxDesk is temporarily unavailable',
            message: state.message,
            ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
          }}
        />
        <Button type="button" size="lg" className="w-full" onClick={refresh}>
          Try again
        </Button>
      </AuthLayout>
    );
  }

  if (state.status === 'anonymous') {
    // The URL is left untouched, so a deep link such as /users opens that page
    // once sign-in completes.
    return (
      <>
        <DocumentTitle title="Sign in" />
        <LoginPage
          expired={state.expired}
          onAuthenticated={onAuthenticated}
          onMfaRequired={setChallenge}
        />
      </>
    );
  }

  if (!state.session.user.mfaEnrolled) {
    return (
      <>
        <DocumentTitle title="Set up multi-factor authentication" />
        <MfaEnrollmentPage onComplete={onMfaEnrollmentComplete} />
      </>
    );
  }

  if (!state.session.session.mfaVerified) {
    return (
      <AuthLayout>
        <DocumentTitle title="Verify your session" />
        <AuthHeading
          title="Verify your session"
          description="Sign in again to complete multi-factor verification."
        />
        <Button type="button" size="lg" className="w-full" onClick={refresh}>
          Refresh session
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AppShell>
      <Routes>
        {NAV_ROUTES.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              <>
                <DocumentTitle title={route.title} />
                {/* UI gating only: the API enforces every permission. */}
                {route.permission === undefined || can(route.permission) ? (
                  PAGES[route.path]
                ) : (
                  <PermissionDenied />
                )}
              </>
            }
          />
        ))}
        <Route
          path={ROUTE_PATHS.newClient}
          element={
            <>
              <DocumentTitle title="New client" />
              {can('clients.manage') ? <ClientFormPage mode="create" /> : <PermissionDenied />}
            </>
          }
        />
        <Route
          path={`${ROUTE_PATHS.clients}/:clientId`}
          element={can('clients.read') ? <ClientDetailPage /> : <PermissionDenied />}
        />
        <Route
          path={`${ROUTE_PATHS.clients}/:clientId/edit`}
          element={can('clients.manage') ? <ClientFormPage mode="edit" /> : <PermissionDenied />}
        />
        {/* An activation link opened without a token, or after activation. */}
        <Route
          path={ROUTE_PATHS.activate}
          element={<Navigate to={ROUTE_PATHS.dashboard} replace />}
        />
        <Route
          path="*"
          element={
            <>
              <DocumentTitle title="Page not found" />
              <NotFoundPage />
            </>
          }
        />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    // The content security policy allows only same-origin stylesheets
    // (style-src 'self'), so Base UI must not inject <style> elements.
    <BrowserRouter>
      <CSPProvider disableStyleElements>
        <SessionProvider>
          <AppContent />
        </SessionProvider>
      </CSPProvider>
    </BrowserRouter>
  );
}

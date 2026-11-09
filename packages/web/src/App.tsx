import { useCallback, useState } from 'react';
import type { CurrentSession } from '@taxdesk/shared';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { Button } from '@/components/ui/button';
import { AppShell, type View } from './components/AppShell.js';
import { ErrorAlert, LoadingMessage, PermissionDenied } from './components/feedback.js';
import { AuthHeading, AuthLayout } from './components/layout/AuthLayout.js';
import { ActivationPage } from './pages/ActivationPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FirmSettingsPage } from './pages/FirmSettingsPage.js';
import { LoginPage, type MfaChallengeState } from './pages/LoginPage.js';
import { MfaChallengePage } from './pages/MfaChallengePage.js';
import { MfaEnrollmentPage } from './pages/MfaEnrollmentPage.js';
import { SecurityPage } from './pages/SecurityPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { SessionProvider, useSession } from './session/session-context.js';

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
  const [view, setView] = useState<View>('dashboard');

  const onAuthenticated = useCallback(
    (session: CurrentSession) => {
      adopt(session);
      setChallenge(null);
    },
    [adopt],
  );

  const onActivationDone = useCallback(() => {
    setActivationToken(null);
    window.history.replaceState({}, '', '/');
    refresh();
  }, [refresh]);

  const onMfaEnrollmentComplete = useCallback(() => {
    refresh();
  }, [refresh]);

  if (activationToken !== null) {
    return <ActivationPage token={activationToken} onDone={onActivationDone} />;
  }

  if (challenge !== null) {
    return (
      <MfaChallengePage
        challenge={challenge}
        onAuthenticated={onAuthenticated}
        onStartOver={() => {
          setChallenge(null);
        }}
      />
    );
  }

  if (state.status === 'loading') {
    return (
      <AuthLayout>
        <AuthHeading title="TaxDesk" />
        <LoadingMessage>Loading your session…</LoadingMessage>
      </AuthLayout>
    );
  }

  if (state.status === 'error') {
    return (
      <AuthLayout>
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
    return (
      <LoginPage
        expired={state.expired}
        onAuthenticated={onAuthenticated}
        onMfaRequired={setChallenge}
      />
    );
  }

  if (!state.session.user.mfaEnrolled) {
    return <MfaEnrollmentPage onComplete={onMfaEnrollmentComplete} />;
  }

  if (!state.session.session.mfaVerified) {
    return (
      <AuthLayout>
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
    <AppShell view={view} onNavigate={setView}>
      {view === 'dashboard' && <DashboardPage />}
      {view === 'security' && <SecurityPage />}
      {view === 'users' && (can('users.manage') ? <UsersPage /> : <PermissionDenied />)}
      {view === 'firm' && (can('firm.settings.read') ? <FirmSettingsPage /> : <PermissionDenied />)}
      {view === 'audit' && (can('audit.read') ? <AuditPage /> : <PermissionDenied />)}
    </AppShell>
  );
}

export function App() {
  return (
    // The content security policy allows only same-origin stylesheets
    // (style-src 'self'), so Base UI must not inject <style> elements.
    <CSPProvider disableStyleElements>
      <SessionProvider>
        <AppContent />
      </SessionProvider>
    </CSPProvider>
  );
}

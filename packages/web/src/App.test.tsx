import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { permissionsForRoles, type CurrentSession, type RoleKey } from '@taxdesk/shared';
import { App } from './App.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const USER_ID = '0198a000-0000-7000-8000-000000000001';
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:30:00.000Z';

function sessionFor(
  input: {
    roles?: readonly RoleKey[];
    mfaEnrolled?: boolean;
    mfaVerified?: boolean;
  } = {},
): CurrentSession {
  const roles = input.roles ?? ['administrator'];
  return {
    user: {
      id: USER_ID,
      email: 'person@example.test',
      displayName: 'Test Person',
      status: 'active',
      mfaEnrolled: input.mfaEnrolled ?? true,
      createdAt: NOW,
    },
    roles: [...roles],
    permissions: permissionsForRoles(roles),
    session: {
      idleExpiresAt: LATER,
      absoluteExpiresAt: '2026-01-01T12:00:00.000Z',
      mfaVerified: input.mfaVerified ?? true,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-test' },
  });
}

function problem(status: number, code: string, detail: string, requestId = 'req-test'): Response {
  return new Response(
    JSON.stringify({
      type: `https://taxdesk.app/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: 'Error',
      status,
      code,
      detail,
      requestId,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/problem+json', 'X-Request-Id': requestId },
    },
  );
}

function mockFetchSequence(responses: readonly (() => Response)[]): void {
  const sequence = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      const next = sequence.shift();
      if (next === undefined) {
        return problem(500, 'INTERNAL_ERROR', 'No more mocked responses.');
      }
      return next();
    }),
  );
}

function anonymous(): Response {
  return problem(401, 'UNAUTHENTICATED', 'Sign in to continue.');
}

async function fillLogin(email = 'person@example.test', password = 'correct horse battery staple') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('login states', () => {
  it('shows the login form when there is no session', async () => {
    mockFetchSequence([anonymous]);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in to TaxDesk' })).toBeInTheDocument();
    expect(screen.getByText(/There is no public registration/)).toBeInTheDocument();
  });

  it('shows a generic invalid-credential error with a reference ID', async () => {
    mockFetchSequence([
      anonymous,
      () => problem(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.', 'req-bad'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to TaxDesk' });
    await fillLogin();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in failed');
    expect(alert).toHaveTextContent('The email or password is incorrect.');
    expect(alert).toHaveTextContent('req-bad');
    expect(alert).not.toHaveTextContent('password hash');
  });

  it('shows a friendly server error and keeps the form available', async () => {
    mockFetchSequence([
      anonymous,
      () => problem(500, 'INTERNAL_ERROR', 'The server could not complete the request.', 'req-500'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to TaxDesk' });
    await fillLogin();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('req-500');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('shows the expired-session state when the session cookie is stale', async () => {
    mockFetchSequence([() => problem(401, 'SESSION_EXPIRED', 'Your session expired.', 'req-old')]);
    render(<App />);
    expect(await screen.findByText(/Your session expired/)).toBeInTheDocument();
  });

  it('has no serious accessibility violations on the login form', async () => {
    mockFetchSequence([anonymous]);
    const rendered = render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to TaxDesk' });
    const results = await axe(rendered.container);
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toHaveLength(0);
  });
});

describe('MFA challenge', () => {
  it('verifies a TOTP code and opens the dashboard', async () => {
    const authenticated = sessionFor();
    mockFetchSequence([
      anonymous,
      () =>
        json({
          status: 'mfa_required',
          challengeToken: 'challenge-token-value-1234',
          expiresAt: LATER,
        }),
      () => json({ status: 'authenticated', session: authenticated }),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to TaxDesk' });
    await fillLogin();

    expect(
      await screen.findByRole('heading', { name: 'Multi-factor verification' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(
      await screen.findByRole('heading', { name: /Welcome, Test Person/ }),
    ).toBeInTheDocument();
  });

  it('explains an invalid MFA code without losing the challenge', async () => {
    mockFetchSequence([
      anonymous,
      () =>
        json({
          status: 'mfa_required',
          challengeToken: 'challenge-token-value-1234',
          expiresAt: LATER,
        }),
      () => problem(401, 'MFA_CODE_INVALID', 'That code is not valid. Try the next one.'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to TaxDesk' });
    await fillLogin();
    await screen.findByRole('heading', { name: 'Multi-factor verification' });
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not valid');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument();
  });
});

describe('MFA enrollment', () => {
  it('confirms enrollment and shows recovery codes once', async () => {
    const enrollmentSession = sessionFor({ mfaEnrolled: false, mfaVerified: false });
    mockFetchSequence([
      () => json(enrollmentSession),
      () =>
        json({
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/TaxDesk%3Aperson?secret=JBSWY3DPEHPK3PXP&issuer=TaxDesk',
          issuer: 'TaxDesk',
        }),
      () => json({ recoveryCodes: ['ABCD-EFGH-IJKL-MNOP', 'QRST-UVWX-YZ23-4567'] }),
      () => json(sessionFor()),
    ]);
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Set up multi-factor authentication' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /QR code that adds TaxDesk to your authenticator app/ }),
    ).toBeInTheDocument();
    const results = await axe(document.body);
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable MFA' }));

    expect(await screen.findByText('ABCD-EFGH-IJKL-MNOP')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I have saved these codes' }));
    expect(
      await screen.findByRole('heading', { name: /Welcome, Test Person/ }),
    ).toBeInTheDocument();
  });
});

describe('authorization and session lifecycle in the UI', () => {
  it('gates navigation by permission but leaves enforcement to the API', async () => {
    const consultant = sessionFor({ roles: ['consultant'] });
    mockFetchSequence([() => json(consultant)]);
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: /Welcome, Test Person/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Security' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Audit history' })).not.toBeInTheDocument();
  });

  it('returns to the expired login state when the session is revoked mid-use', async () => {
    mockFetchSequence([
      () => json(sessionFor()),
      () => problem(401, 'SESSION_EXPIRED', 'Your session expired.', 'req-revoked'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    expect(await screen.findByText(/Your session expired/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in to TaxDesk' })).toBeInTheDocument();
  });

  it('shows a server-side permission denial without signing the user out', async () => {
    mockFetchSequence([
      () => json(sessionFor()),
      () => problem(403, 'FORBIDDEN', 'You do not have permission.', 'req-denied'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Firm settings' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Access denied');
    expect(alert).toHaveTextContent('req-denied');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('keeps the user signed in after a wrong password while disabling MFA', async () => {
    mockFetchSequence([
      () => json(sessionFor()),
      () => problem(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.', 'req-pw'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Security' }));
    await screen.findByRole('heading', { name: 'Security' });
    fireEvent.change(screen.getAllByLabelText('Password').at(-1)!, {
      target: { value: 'wrong password value' },
    });
    fireEvent.change(screen.getAllByLabelText('Authenticator code').at(-1)!, {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByLabelText(/MFA will be removed/));
    fireEvent.click(screen.getByRole('button', { name: 'Disable MFA' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is incorrect.',
    );
    expect(screen.getByRole('heading', { name: 'Security' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to TaxDesk' })).not.toBeInTheDocument();
  });

  it('deactivates a user and reports that their sessions were revoked', async () => {
    const staff = {
      id: '0198a000-0000-7000-8000-000000000003',
      email: 'staff@example.test',
      displayName: 'Staff Person',
      status: 'active' as const,
      roles: ['consultant' as const],
      mfaEnrolled: true,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    };
    const fetchMock = vi.fn();
    const sequence = [
      () => json(sessionFor()),
      () => json({ users: [staff] }),
      () => json({ ...staff, status: 'deactivated', version: 2 }),
    ];
    fetchMock.mockImplementation(async () => {
      const next = sequence.shift();
      return next === undefined ? problem(500, 'INTERNAL_ERROR', 'No more responses.') : next();
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByText('Staff Person');
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(
      await screen.findByText('Deactivated staff@example.test. Their sessions were revoked.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe(`/api/v1/admin/users/${staff.id}`);
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"1"');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'deactivated' });
  });

  it('sends a deactivated user back to sign in on their next request', async () => {
    mockFetchSequence([
      () => json(sessionFor({ roles: ['consultant'] })),
      () => problem(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.', 'req-deact'),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Firm settings' }));
    expect(await screen.findByText(/Your session expired/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in to TaxDesk' })).toBeInTheDocument();
  });

  it('signs out and returns to the login page', async () => {
    mockFetchSequence([() => json(sessionFor()), () => new Response(null, { status: 204 })]);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to TaxDesk' })).toBeInTheDocument();
  });

  it('has no serious accessibility violations on the dashboard', async () => {
    mockFetchSequence([() => json(sessionFor())]);
    const rendered = render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    const results = await axe(rendered.container);
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toHaveLength(0);
  });
});

describe('Turnstile and user administration', () => {
  it('asks for verification after repeated failures', async () => {
    mockFetchSequence([
      anonymous,
      () => json({ status: 'turnstile_required', siteKey: 'test-site-key' }),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in to TaxDesk' });
    await fillLogin();
    expect(await screen.findByRole('alert')).toHaveTextContent('Verification required');
    expect(screen.getByText('Loading verification…')).toBeInTheDocument();
  });

  it('shows a one-time activation link after inviting a user', async () => {
    const user = {
      id: '0198a000-0000-7000-8000-000000000002',
      email: 'new@example.test',
      displayName: 'New Person',
      status: 'invited' as const,
      roles: ['consultant' as const],
      mfaEnrolled: false,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    };
    mockFetchSequence([
      () => json(sessionFor()),
      () => json({ users: [] }),
      () =>
        json({
          user,
          activationUrl: 'https://taxdesk.test/activate?token=one-time-token-1234',
          expiresAt: LATER,
        }),
      () => json({ users: [user] }),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: /Welcome, Test Person/ });
    fireEvent.click(screen.getByRole('button', { name: 'Users' }));
    await screen.findByRole('heading', { name: 'Invite a user' });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New Person' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText(/Activation link for new@example.test/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://taxdesk.test/activate?token=one-time-token-1234' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });
});

describe('activation', () => {
  it('activates an invited account from a one-time link', async () => {
    window.history.replaceState({}, '', '/activate?token=activation-token-value-1234');
    mockFetchSequence([
      anonymous,
      () => json({ status: 'activated', email: 'person@example.test' }),
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Activate your TaxDesk account' });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    expect(await screen.findByRole('heading', { name: 'Account activated' })).toBeInTheDocument();
    window.history.replaceState({}, '', '/');
  });
});

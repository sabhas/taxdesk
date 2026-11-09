import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../app.js';
import type { AppEnv } from '../types.js';
import { createTestHarness, seedFirm, seedUser, type TestHarness } from '../testing/harness.js';

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly requestId?: string | null;
  readonly origin?: string;
  readonly headers?: Record<string, string>;
}

let requestCounter = 0;

function appFor(harness: TestHarness): Hono<AppEnv> {
  return createApp({
    dependencyFactory: () => Promise.resolve(harness.dependencies),
    clock: harness.now,
  });
}

async function call(app: Hono<AppEnv>, path: string, options: RequestOptions = {}) {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.cookie !== undefined) {
    headers['Cookie'] = options.cookie;
  }
  const requestId =
    options.requestId === undefined
      ? `test-request-${String(++requestCounter)}`
      : options.requestId;
  if (requestId !== null) {
    headers['X-Request-Id'] = requestId;
  }
  if (options.origin !== undefined) {
    headers['Origin'] = options.origin;
  }
  return await app.request(
    path,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    { ENVIRONMENT: 'development', RELEASE_VERSION: 'test' },
  );
}

function cookieFrom(response: Response): string | undefined {
  const header = response.headers.get('Set-Cookie');
  if (header === null) {
    return undefined;
  }
  const first = header.split(';')[0];
  return first;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return data as Record<string, unknown>;
}

const PASSWORD = 'correct horse battery staple';

describe('login and session lifecycle', () => {
  it('returns one generic failure for an unknown username and a wrong password', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    await seedUser(harness, { username: 'person', password: PASSWORD });
    const app = appFor(harness);

    const unknown = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'missing', password: PASSWORD },
    });
    const wrong = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'person', password: 'wrong password' },
    });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const unknownBody = await json(unknown);
    const wrongBody = await json(wrong);
    expect(unknownBody['code']).toBe('INVALID_CREDENTIALS');
    expect(wrongBody['code']).toBe('INVALID_CREDENTIALS');
    expect(unknownBody['detail']).toBe('The username or password is incorrect.');
    expect(wrongBody['detail']).toBe(unknownBody['detail']);
    expect(unknown.headers.get('Set-Cookie')).toBeNull();
  });

  it('signs in regardless of username case or surrounding spaces', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    await seedUser(harness, { username: 'muaaz.khalid', password: PASSWORD });
    const app = appFor(harness);
    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: '  Muaaz.Khalid ', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect((await json(login))['status']).toBe('mfa_enrollment_required');
  });

  it('issues a restricted session and requires MFA enrollment before application routes', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    await seedUser(harness, { username: 'admin', password: PASSWORD });
    const app = appFor(harness);

    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect((await json(login))['status']).toBe('mfa_enrollment_required');
    const setCookie = login.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain('__Host-taxdesk_session=');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const cookie = cookieFrom(login);

    const sessionResponse = await call(app, '/api/v1/auth/session', { cookie });
    expect(sessionResponse.status).toBe(200);
    const sessionBody = await json(sessionResponse);
    expect((sessionBody['session'] as { mfaVerified: boolean }).mfaVerified).toBe(false);

    const blocked = await call(app, '/api/v1/firm/settings', { cookie });
    expect(blocked.status).toBe(403);
    expect((await json(blocked))['code']).toBe('MFA_ENROLLMENT_REQUIRED');

    const enrollment = await call(app, '/api/v1/auth/mfa/enroll', {
      method: 'POST',
      cookie,
      body: {},
    });
    expect(enrollment.status).toBe(200);
    const enrollmentBody = await json(enrollment);
    const secret = enrollmentBody['secret'] as string;
    expect(enrollmentBody['otpauthUri']).toContain('otpauth://totp/');

    const code = await harness.totp.generate(secret, harness.now().getTime());
    const confirm = await call(app, '/api/v1/auth/mfa/confirm', {
      method: 'POST',
      cookie,
      body: { code },
    });
    expect(confirm.status).toBe(200);
    const recoveryCodes = (await json(confirm))['recoveryCodes'] as string[];
    expect(recoveryCodes).toHaveLength(10);

    const refreshed = await call(app, '/api/v1/auth/session', { cookie });
    const refreshedBody = await json(refreshed);
    expect((refreshedBody['session'] as { mfaVerified: boolean }).mfaVerified).toBe(true);

    const allowed = await call(app, '/api/v1/firm/settings', { cookie });
    expect(allowed.status).toBe(200);
    expect((await json(allowed))['firmName']).toBe('Test Firm');
  });

  it('clears the session on logout and rejects the old cookie', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      username: 'admin',
      password: PASSWORD,
      mfaEnrolled: true,
    });
    const app = appFor(harness);
    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    const challengeToken = (await json(login))['challengeToken'] as string;
    const credential = await harness.repositories.mfa.getCredential(user.id);
    const secret = (await harness.dependencies.cipher?.decrypt(credential!.secretCiphertext)) ?? '';
    const code = await harness.totp.generate(secret, harness.now().getTime());
    const challenge = await call(app, '/api/v1/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code },
    });
    const cookie = cookieFrom(challenge);
    expect(challenge.status).toBe(200);

    const logout = await call(app, '/api/v1/auth/logout', { method: 'POST', cookie, body: {} });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');

    const after = await call(app, '/api/v1/auth/session', { cookie });
    expect(after.status).toBe(401);
    expect((await json(after))['code']).toBe('SESSION_EXPIRED');
  });

  it('expires an idle session after 30 minutes and an absolute session after 12 hours', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      username: 'admin',
      password: PASSWORD,
      mfaEnrolled: true,
    });
    const app = appFor(harness);
    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    const challengeToken = (await json(login))['challengeToken'] as string;
    const credential = await harness.repositories.mfa.getCredential(user.id);
    const secret = (await harness.dependencies.cipher?.decrypt(credential!.secretCiphertext)) ?? '';
    const code = await harness.totp.generate(secret, harness.now().getTime());
    const challenge = await call(app, '/api/v1/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code },
    });
    const cookie = cookieFrom(challenge);

    harness.advance(31 * 60 * 1000);
    const expired = await call(app, '/api/v1/auth/session', { cookie });
    expect(expired.status).toBe(401);
    expect((await json(expired))['code']).toBe('SESSION_EXPIRED');
  });

  it('requires a verified MFA challenge and accepts each recovery code once', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      username: 'admin',
      password: PASSWORD,
      mfaEnrolled: true,
    });
    const app = appFor(harness);
    const credential = await harness.repositories.mfa.getCredential(user.id);
    const secret = (await harness.dependencies.cipher?.decrypt(credential!.secretCiphertext)) ?? '';

    const firstLogin = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: PASSWORD },
    });
    const firstLoginBody = await json(firstLogin);
    expect(firstLoginBody['status']).toBe('mfa_required');
    expect(firstLogin.headers.get('Set-Cookie')).toBeNull();
    const firstChallenge = firstLoginBody['challengeToken'] as string;

    const wrong = await call(app, '/api/v1/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: firstChallenge, code: '000000' },
    });
    expect(wrong.status).toBe(401);
    expect((await json(wrong))['code']).toBe('MFA_CODE_INVALID');

    const code = await harness.totp.generate(secret, harness.now().getTime());
    const verified = await call(app, '/api/v1/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken: firstChallenge, code },
    });
    expect(verified.status).toBe(200);
    expect(cookieFrom(verified)).toContain('__Host-taxdesk_session=');

    // Enroll a fresh user to obtain recovery codes, then use one twice.
    await seedUser(harness, {
      username: 'second',
      password: PASSWORD,
    });
    const secondCookie = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'second', password: PASSWORD },
    });
    expect(secondCookie.status).toBe(200);
    const restricted = cookieFrom(secondCookie);
    const enrollment = await call(app, '/api/v1/auth/mfa/enroll', {
      method: 'POST',
      cookie: restricted,
      body: {},
    });
    const enrollmentSecret = (await json(enrollment))['secret'] as string;
    const confirmCode = await harness.totp.generate(enrollmentSecret, harness.now().getTime());
    const confirm = await call(app, '/api/v1/auth/mfa/confirm', {
      method: 'POST',
      cookie: restricted,
      body: { code: confirmCode },
    });
    const recoveryCode = ((await json(confirm))['recoveryCodes'] as string[])[0]!;

    const recoveryLogin = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'second', password: PASSWORD },
    });
    const recoveryChallenge = (await json(recoveryLogin))['challengeToken'] as string;
    const recovery = await call(app, '/api/v1/auth/mfa/recovery', {
      method: 'POST',
      body: { challengeToken: recoveryChallenge, recoveryCode },
    });
    expect(recovery.status).toBe(200);

    const replayLogin = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'second', password: PASSWORD },
    });
    const replayChallenge = (await json(replayLogin))['challengeToken'] as string;
    const replay = await call(app, '/api/v1/auth/mfa/recovery', {
      method: 'POST',
      body: { challengeToken: replayChallenge, recoveryCode },
    });
    expect(replay.status).toBe(401);
    expect((await json(replay))['code']).toBe('MFA_CODE_INVALID');
  });
});

describe('authentication defenses', () => {
  it('limits second-factor guesses and burns the challenge once denied', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    const { user } = await seedUser(harness, {
      username: 'guess',
      password: PASSWORD,
      mfaEnrolled: true,
    });
    const app = appFor(harness);
    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'guess', password: PASSWORD },
    });
    const challengeToken = (await json(login))['challengeToken'] as string;

    let denied: Response | undefined;
    for (let attempt = 0; attempt < 20 && denied === undefined; attempt += 1) {
      const guess = await call(app, '/api/v1/auth/mfa/challenge', {
        method: 'POST',
        body: { challengeToken, code: String(100000 + attempt) },
      });
      if (guess.status === 429) {
        denied = guess;
      } else {
        expect((await json(guess))['code']).toBe('MFA_CODE_INVALID');
      }
    }
    expect(denied?.status).toBe(429);
    expect(denied?.headers.get('Retry-After')).not.toBeNull();

    // Even the correct code no longer works on the burned challenge.
    const credential = await harness.repositories.mfa.getCredential(user.id);
    const secret = (await harness.dependencies.cipher?.decrypt(credential!.secretCiphertext)) ?? '';
    const code = await harness.totp.generate(secret, harness.now().getTime());
    const late = await call(app, '/api/v1/auth/mfa/challenge', {
      method: 'POST',
      body: { challengeToken, code },
    });
    expect(late.status).toBe(401);
    expect((await json(late))['code']).toBe('MFA_CHALLENGE_INVALID');
  });

  it('records MFA audit events with the caller request ID', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    await seedUser(harness, { username: 'enroll', password: PASSWORD });
    const app = appFor(harness);
    const login = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'enroll', password: PASSWORD },
    });
    const cookie = cookieFrom(login);
    const enrollment = await call(app, '/api/v1/auth/mfa/enroll', {
      method: 'POST',
      cookie,
      body: {},
    });
    const secret = (await json(enrollment))['secret'] as string;
    const code = await harness.totp.generate(secret, harness.now().getTime());
    const confirm = await call(app, '/api/v1/auth/mfa/confirm', {
      method: 'POST',
      cookie,
      body: { code },
      requestId: 'req-mfa-confirm',
    });
    expect(confirm.status).toBe(200);
    const page = await harness.repositories.audit.list({ limit: 100, cursor: null });
    const enabled = page.events.find((event) => event.action === 'user.mfa_enabled');
    expect(enabled?.requestId).toBe('req-mfa-confirm');
  });

  it('requires a request ID on mutations and rejects a foreign origin', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    await seedUser(harness, { username: 'person', password: PASSWORD });
    const app = appFor(harness);

    const missingId = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'person', password: PASSWORD },
      requestId: null,
    });
    expect(missingId.status).toBe(400);
    expect((await json(missingId))['code']).toBe('REQUEST_ID_REQUIRED');

    const foreign = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'person', password: PASSWORD },
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBe(403);
    expect((await json(foreign))['code']).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('sets restrictive security headers on API responses', async () => {
    const harness = createTestHarness();
    const app = appFor(harness);
    const response = await call(app, '/health');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('escalates to Turnstile after repeated failures and then rate-limits', async () => {
    const harness = createTestHarness();
    await seedFirm(harness);
    await seedUser(harness, { username: 'person', password: PASSWORD });
    const app = appFor(harness);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call(app, '/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'person', password: 'wrong password' },
      });
      expect(response.status).toBe(401);
    }

    const challenge = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'person', password: PASSWORD },
    });
    expect(challenge.status).toBe(200);
    const challengeBody = await json(challenge);
    expect(challengeBody['status']).toBe('turnstile_required');
    expect(challengeBody['siteKey']).toBe('test-site-key');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(app, '/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'person', password: 'wrong password' },
      });
    }
    const denied = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'person', password: PASSWORD },
    });
    expect(denied.status).toBe(429);
    expect((await json(denied))['code']).toBe('TOO_MANY_ATTEMPTS');
    expect(denied.headers.get('Retry-After')).not.toBeNull();
  });

  it('accepts a verified Turnstile token after failures', async () => {
    const harness = createTestHarness({ turnstileValid: true });
    await seedFirm(harness);
    await seedUser(harness, { username: 'person', password: PASSWORD });
    const app = appFor(harness);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(app, '/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'person', password: 'wrong password' },
      });
    }
    const accepted = await call(app, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        username: 'person',
        password: PASSWORD,
        turnstileToken: 'verified-token',
      },
    });
    expect(accepted.status).toBe(200);
    expect((await json(accepted))['status']).toBe('mfa_enrollment_required');
  });
});

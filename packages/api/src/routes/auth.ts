import { Hono, type Context } from 'hono';
import {
  ActivationRequestSchema,
  ActivationResponseSchema,
  CurrentSessionSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MfaChallengeRequestSchema,
  MfaConfirmRequestSchema,
  MfaDisableRequestSchema,
  MfaEnrollmentSchema,
  MfaRecoveryRequestSchema,
  RegenerateRecoveryCodesRequestSchema,
  RecoveryCodesSchema,
} from '@taxdesk/shared';
import type { AppEnv } from '../types.js';
import { serializeClearedSessionCookie, serializeSessionCookie } from '../transport/cookies.js';
import { clientIp, parseJsonBody } from '../transport/request.js';
import { SESSION_ABSOLUTE_TIMEOUT_MS } from '../domain/auth/session-policy.js';
import { protect } from '../middleware/auth.js';

export const authRoutes = new Hono<AppEnv>();

authRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

function remoteIpField(c: Context<AppEnv>): { remoteIp?: string } {
  const remoteIp = clientIp(c);
  return remoteIp === undefined ? {} : { remoteIp };
}

function setSessionCookie(c: Context<AppEnv>, token: string): void {
  c.header(
    'Set-Cookie',
    serializeSessionCookie(token, Math.floor(SESSION_ABSOLUTE_TIMEOUT_MS / 1000)),
  );
}

authRoutes.post('/login', protect({ access: 'public' }), async (c) => {
  const body = await parseJsonBody(c, LoginRequestSchema);
  const remoteIp = clientIp(c);
  const outcome = await c.get('dependencies').authService.login({
    email: body.email,
    password: body.password,
    ...(body.turnstileToken === undefined ? {} : { turnstileToken: body.turnstileToken }),
    ...(remoteIp === undefined ? {} : { remoteIp }),
    requestId: c.get('requestId'),
  });

  if (outcome.status === 'turnstile_required') {
    const siteKey = c.get('dependencies').authConfig.turnstileSiteKey;
    if (siteKey === undefined) {
      throw new Error('Turnstile is required but no site key is configured.');
    }
    return c.json(LoginResponseSchema.parse({ status: 'turnstile_required', siteKey }));
  }
  if (outcome.status === 'mfa_required') {
    const siteKey = c.get('dependencies').authConfig.turnstileSiteKey;
    return c.json(
      LoginResponseSchema.parse({
        status: 'mfa_required',
        challengeToken: outcome.challengeToken,
        expiresAt: outcome.expiresAt,
        ...(siteKey === undefined ? {} : { siteKey }),
      }),
    );
  }

  setSessionCookie(c, outcome.issued.token);
  return c.json(
    LoginResponseSchema.parse(
      outcome.status === 'authenticated'
        ? { status: 'authenticated', session: outcome.issued.view }
        : { status: 'mfa_enrollment_required', session: outcome.issued.view },
    ),
  );
});

authRoutes.post('/mfa/challenge', protect({ access: 'public' }), async (c) => {
  const body = await parseJsonBody(c, MfaChallengeRequestSchema);
  const issued = await c.get('dependencies').authService.completeMfaChallenge({
    challengeToken: body.challengeToken,
    code: body.code,
    ...remoteIpField(c),
    requestId: c.get('requestId'),
  });
  setSessionCookie(c, issued.token);
  return c.json(LoginResponseSchema.parse({ status: 'authenticated', session: issued.view }));
});

authRoutes.post('/mfa/recovery', protect({ access: 'public' }), async (c) => {
  const body = await parseJsonBody(c, MfaRecoveryRequestSchema);
  const issued = await c.get('dependencies').authService.completeMfaRecovery({
    challengeToken: body.challengeToken,
    recoveryCode: body.recoveryCode,
    ...remoteIpField(c),
    requestId: c.get('requestId'),
  });
  setSessionCookie(c, issued.token);
  return c.json(LoginResponseSchema.parse({ status: 'authenticated', session: issued.view }));
});

authRoutes.post('/activate', protect({ access: 'public' }), async (c) => {
  const body = await parseJsonBody(c, ActivationRequestSchema);
  const result = await c.get('dependencies').authService.activate({
    token: body.token,
    password: body.password,
    requestId: c.get('requestId'),
  });
  return c.json(ActivationResponseSchema.parse({ status: 'activated', email: result.email }));
});

authRoutes.get('/session', protect({ access: 'session' }), (c) => {
  const session = c.get('dependencies').authService.currentSession(c.get('actor'));
  return c.json(CurrentSessionSchema.parse(session));
});

authRoutes.post('/logout', protect({ access: 'session' }), async (c) => {
  await c.get('dependencies').authService.logout(c.get('actor'), c.get('requestId'));
  c.header('Set-Cookie', serializeClearedSessionCookie());
  return c.body(null, 204);
});

authRoutes.post('/mfa/enroll', protect({ access: 'session' }), async (c) => {
  const enrollment = await c.get('dependencies').mfaService.beginEnrollment(c.get('actor'));
  return c.json(MfaEnrollmentSchema.parse(enrollment));
});

authRoutes.post('/mfa/confirm', protect({ access: 'session' }), async (c) => {
  const body = await parseJsonBody(c, MfaConfirmRequestSchema);
  const codes = await c
    .get('dependencies')
    .mfaService.confirmEnrollment(c.get('actor'), body.code, c.get('requestId'));
  return c.json(RecoveryCodesSchema.parse(codes));
});

authRoutes.post('/mfa/disable', protect({ access: 'self_service' }), async (c) => {
  const body = await parseJsonBody(c, MfaDisableRequestSchema);
  await c.get('dependencies').mfaService.disable(
    c.get('actor'),
    {
      password: body.password,
      code: body.code,
    },
    c.get('requestId'),
  );
  return c.body(null, 204);
});

authRoutes.post(
  '/mfa/recovery-codes/regenerate',
  protect({ access: 'self_service' }),
  async (c) => {
    const body = await parseJsonBody(c, RegenerateRecoveryCodesRequestSchema);
    const codes = await c.get('dependencies').mfaService.regenerateRecoveryCodes(
      c.get('actor'),
      {
        password: body.password,
        code: body.code,
      },
      c.get('requestId'),
    );
    return c.json(RecoveryCodesSchema.parse(codes));
  },
);

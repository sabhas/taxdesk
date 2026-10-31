import { describe, expect, it } from 'vitest';
import { OAuthCallbackError, startLoopbackOAuthServer } from './loopback-oauth.js';

const STATE = 'state-abc123';

async function withServer(
  run: (context: {
    redirectUri: string;
    waitForAuthorizationCode: () => Promise<string>;
  }) => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const server = await startLoopbackOAuthServer({
    port: 0,
    expectedState: STATE,
    ...options,
  });
  try {
    await run({
      redirectUri: server.redirectUri,
      waitForAuthorizationCode: () => server.waitForAuthorizationCode(),
    });
  } finally {
    await server.close();
  }
}

describe('startLoopbackOAuthServer', () => {
  it('binds the registered callback path and returns the authorization code', async () => {
    await withServer(async ({ redirectUri, waitForAuthorizationCode }) => {
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

      const pending = waitForAuthorizationCode();
      const response = await fetch(`${redirectUri}?code=the-code&state=${STATE}`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain('consent received');
      await expect(pending).resolves.toBe('the-code');
    });
  });

  it('rejects a callback whose state does not match this run', async () => {
    await withServer(async ({ redirectUri, waitForAuthorizationCode }) => {
      const pending = waitForAuthorizationCode();
      const response = await fetch(`${redirectUri}?code=the-code&state=wrong-state`);

      expect(response.status).toBe(400);
      const error = await pending.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OAuthCallbackError);
      expect((error as OAuthCallbackError).code).toBe('state_mismatch');
    });
  });

  it('rejects a callback that reports an authorization error', async () => {
    await withServer(async ({ redirectUri, waitForAuthorizationCode }) => {
      const pending = waitForAuthorizationCode();
      const response = await fetch(`${redirectUri}?error=access_denied&state=${STATE}`);

      expect(response.status).toBe(400);
      const error = await pending.catch((caught: unknown) => caught);
      expect((error as OAuthCallbackError).code).toBe('access_denied');
    });
  });

  it('rejects a callback without an authorization code', async () => {
    await withServer(async ({ redirectUri, waitForAuthorizationCode }) => {
      const pending = waitForAuthorizationCode();
      const response = await fetch(`${redirectUri}?state=${STATE}`);

      expect(response.status).toBe(400);
      const error = await pending.catch((caught: unknown) => caught);
      expect((error as OAuthCallbackError).code).toBe('missing_code');
    });
  });

  it('answers unknown paths with 404 without settling the code', async () => {
    await withServer(async ({ redirectUri, waitForAuthorizationCode }) => {
      const pending = waitForAuthorizationCode();
      const response = await fetch(redirectUri.replace('/oauth/callback', '/other'));

      expect(response.status).toBe(404);
      await expect(
        Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')]),
      ).resolves.toBe('pending');
    });
  });

  it('gives up when the operator never completes consent', async () => {
    await withServer(
      async ({ waitForAuthorizationCode }) => {
        const error = await waitForAuthorizationCode().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OAuthCallbackError);
        expect((error as OAuthCallbackError).code).toBe('callback_timeout');
      },
      { timeoutMs: 25 },
    );
  });
});

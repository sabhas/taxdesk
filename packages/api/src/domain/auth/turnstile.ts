export interface TurnstileVerificationInput {
  readonly token: string;
  readonly remoteIp: string | undefined;
}

export interface TurnstileVerifier {
  readonly configured: boolean;
  verify(input: TurnstileVerificationInput): Promise<boolean>;
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile Siteverify client. A missing secret is not a bypass: the
 * verifier reports `configured: false` and callers return a service error when
 * verification is required.
 */
export function createTurnstileVerifier(
  secretKey: string | undefined,
  fetcher: typeof fetch = globalThis.fetch,
): TurnstileVerifier {
  if (secretKey === undefined || secretKey.trim() === '') {
    return {
      configured: false,
      verify: () => Promise.resolve(false),
    };
  }
  return {
    configured: true,
    verify: async (input) => {
      const body = new URLSearchParams({ secret: secretKey, response: input.token });
      if (input.remoteIp !== undefined) {
        body.set('remoteip', input.remoteIp);
      }
      try {
        const response = await fetcher(SITEVERIFY_URL, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!response.ok) {
          return false;
        }
        const payload: unknown = await response.json();
        if (typeof payload !== 'object' || payload === null) {
          return false;
        }
        return 'success' in payload && payload.success === true;
      } catch {
        return false;
      }
    },
  };
}

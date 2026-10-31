import { createServer, type ServerResponse } from 'node:http';
import { ONEDRIVE_SPIKE_CALLBACK_PATH } from '@taxdesk/shared';

/**
 * A loopback OAuth callback listener for the delegated authorization-code flow.
 *
 * Microsoft only accepts `http` for loopback redirect URIs, which is exactly what
 * TD-005 needs to prove: the registered callback works end to end without
 * exposing an internet-facing redirect endpoint.
 */

export class OAuthCallbackError extends Error {
  constructor(readonly code: string) {
    super(`Delegated OAuth callback failed with ${code}.`);
    this.name = 'OAuthCallbackError';
  }
}

export interface LoopbackOAuthServer {
  readonly redirectUri: string;
  waitForAuthorizationCode(): Promise<string>;
  close(): Promise<void>;
}

export interface LoopbackOAuthServerOptions {
  readonly port: number;
  readonly expectedState: string;
  readonly host?: string;
  readonly timeoutMs?: number;
}

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function respondHtml(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(`${message}\n`);
}

export async function startLoopbackOAuthServer(
  options: LoopbackOAuthServerOptions,
): Promise<LoopbackOAuthServer> {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;

  let settled = false;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const authorizationCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The caller awaits `waitForAuthorizationCode()`; this guard only prevents an
  // unhandled rejection when the promise settles before that call.
  void authorizationCode.catch(() => undefined);

  const succeed = (code: string): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolveCode(code);
  };

  const fail = (error: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectCode(error);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (url.pathname !== ONEDRIVE_SPIKE_CALLBACK_PATH) {
      respondHtml(response, 404, 'Not found.');
      return;
    }

    const error = url.searchParams.get('error');
    if (error !== null) {
      respondHtml(response, 400, 'Authorization was not granted. You can close this window.');
      fail(new OAuthCallbackError(error));
      return;
    }

    if (url.searchParams.get('state') !== options.expectedState) {
      respondHtml(
        response,
        400,
        'The callback state did not match this run. You can close this window.',
      );
      fail(new OAuthCallbackError('state_mismatch'));
      return;
    }

    const code = url.searchParams.get('code');
    if (code === null || code.length === 0) {
      respondHtml(response, 400, 'The callback did not include an authorization code.');
      fail(new OAuthCallbackError('missing_code'));
      return;
    }

    respondHtml(response, 200, 'TaxDesk spike consent received. You can close this window.');
    succeed(code);
  });

  const timer = setTimeout(() => {
    fail(new OAuthCallbackError('callback_timeout'));
  }, timeoutMs);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    redirectUri: `http://${host}:${String(boundPort)}${ONEDRIVE_SPIKE_CALLBACK_PATH}`,
    waitForAuthorizationCode: () => authorizationCode,
    close: async () => {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

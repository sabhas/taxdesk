import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  StorageCallbackRequestSchema,
  type StorageCallbackRequest,
  type StorageCallbackResult,
} from '@taxdesk/shared';
import { LoadingMessage } from '../../components/feedback.js';
import { PageHeader } from '../../components/layout/PageHeader.js';
import { ROUTE_PATHS } from '../../routes.js';
import { completeStorageConnection } from '../../storage-api.js';

const CALLBACK_KEYS = ['code', 'state', 'error', 'error_description'] as const;

/**
 * Completions already sent, keyed by the callback query. React StrictMode runs
 * effects twice in development; a second POST would find the OAuth state
 * consumed and report `invalid_state`, so both runs share one request.
 */
const inFlight = new Map<string, Promise<StorageCallbackResult>>();

function readCallback(search: string): StorageCallbackRequest | null {
  const parameters = new URLSearchParams(search);
  const raw: Record<string, string> = {};
  for (const key of CALLBACK_KEYS) {
    const value = parameters.get(key);
    if (value !== null && value.length > 0) raw[key] = value;
  }
  const parsed = StorageCallbackRequestSchema.safeParse(raw);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : null;
}

function complete(request: StorageCallbackRequest): Promise<StorageCallbackResult> {
  const key = JSON.stringify(request);
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const pending = completeStorageConnection(request)
    .then((response) => response.result)
    .catch((): StorageCallbackResult => 'failed');
  inFlight.set(key, pending);
  return pending;
}

/** Test hook: forget completed callbacks between tests. */
export function resetStorageCallbacksForTests(): void {
  inFlight.clear();
}

/**
 * Landing page for the storage provider's consent redirect (TD-403). The
 * provider's cross-site redirect cannot carry the SameSite=Strict session
 * cookie to the API, so the signed-in app receives the code here and posts it
 * same-origin. The code is removed from the address bar and history at once.
 */
export function StorageCallbackPage() {
  const headingId = useId();
  const navigate = useNavigate();
  // Read once on first render, before the effect strips the query string.
  const [request] = useState(() => readCallback(window.location.search));

  useEffect(() => {
    if (window.location.search.length > 0) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    let active = true;
    const outcome: Promise<StorageCallbackResult> =
      request === null ? Promise.resolve('invalid_state') : complete(request);
    void outcome.then((result) => {
      if (active) {
        void navigate(`${ROUTE_PATHS.storage}?result=${result}`, { replace: true });
      }
    });
    return () => {
      active = false;
    };
  }, [navigate, request]);

  return (
    <section aria-labelledby={headingId}>
      <PageHeader id={headingId} title="Document storage" />
      <LoadingMessage>Finishing connection…</LoadingMessage>
    </section>
  );
}

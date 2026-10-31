import { useEffect, useState } from 'react';
import type { Health } from '@taxdesk/shared';
import { loadHealth, type HealthLoadResult } from './health-client.js';

type LoadState = { status: 'loading' } | HealthLoadResult;

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void loadHealth().then((result) => {
      if (!cancelled) {
        setState(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <main>
      <h1>TaxDesk</h1>

      {state.status === 'loading' && (
        <p role="status" aria-live="polite">
          Connecting to the TaxDesk service…
        </p>
      )}

      {state.status === 'failure' && (
        <section role="alert" className="error-panel" aria-labelledby="service-error-heading">
          <h2 id="service-error-heading">TaxDesk is temporarily unavailable</h2>
          <p>
            We could not reach the TaxDesk service. Check your connection and try again. If the
            problem continues, contact your administrator.
          </p>
          {state.requestId && (
            <p>
              Reference ID: <code>{state.requestId}</code>
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setAttempt((current) => current + 1);
            }}
          >
            Try again
          </button>
        </section>
      )}

      {state.status === 'success' && <ServiceStatus health={state.health} />}
    </main>
  );
}

function ServiceStatus({ health }: { health: Health }) {
  return (
    <section aria-labelledby="service-status-heading">
      <h2 id="service-status-heading">Service status</h2>
      <p>TaxDesk is connected to the {health.environment} environment.</p>
      <dl>
        <dt>Environment</dt>
        <dd>{health.environment}</dd>
        <dt>Version</dt>
        <dd>{health.releaseVersion}</dd>
        <dt>Request ID</dt>
        <dd>
          <code>{health.requestId}</code>
        </dd>
      </dl>
    </section>
  );
}

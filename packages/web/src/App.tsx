import { useEffect, useState } from 'react';
import { AppInfoSchema, type AppInfo } from '@taxdesk/shared';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; appInfo: AppInfo };

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch('/api/v1/app-info');
        if (!response.ok) {
          throw new Error(`API request failed with status ${String(response.status)}`);
        }
        const data = (await response.json()) as unknown;
        const parsed = AppInfoSchema.safeParse(data);
        if (!parsed.success) {
          throw new Error('API response did not match the expected contract');
        }
        if (!cancelled) {
          setState({ status: 'success', appInfo: parsed.data });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to load app information',
          });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>TaxDesk</h1>
      {state.status === 'loading' && (
        <p role="status" aria-live="polite">
          Loading application information…
        </p>
      )}
      {state.status === 'error' && (
        <div role="alert">
          <p>Unable to load application information.</p>
          <p>{state.message}</p>
        </div>
      )}
      {state.status === 'success' && (
        <dl>
          <dt>Application</dt>
          <dd>{state.appInfo.name}</dd>
          <dt>Version</dt>
          <dd>{state.appInfo.version}</dd>
          <dt>Environment</dt>
          <dd>{state.appInfo.environment}</dd>
        </dl>
      )}
    </main>
  );
}

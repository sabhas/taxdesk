import { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = 'taxdesk-turnstile-script';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Cloudflare Turnstile widget. Verification is only requested after repeated
 * login failures; the token is submitted with the next sign-in attempt.
 */
export function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    const render = (): void => {
      if (cancelled || container.current === null || window.turnstile === undefined) {
        return;
      }
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: onToken,
        'expired-callback': () => {
          onToken('');
        },
        'error-callback': () => {
          setStatus('error');
        },
      });
      setStatus('ready');
    };

    if (window.turnstile !== undefined) {
      render();
    } else {
      let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (script === null) {
        script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.src = SCRIPT_URL;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', render);
      const timeout = window.setTimeout(() => {
        if (!cancelled && window.turnstile === undefined) {
          setStatus('error');
        }
      }, 8_000);

      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
        script.removeEventListener('load', render);
        const api = window.turnstile;
        if (widgetId.current !== null && api !== undefined) {
          api.remove(widgetId.current);
        }
      };
    }

    return () => {
      cancelled = true;
      if (widgetId.current !== null) {
        window.turnstile?.remove(widgetId.current);
      }
    };
  }, [siteKey, onToken]);

  return (
    <div className="turnstile">
      <div ref={container} />
      {status === 'loading' && (
        <p role="status" className="muted">
          Loading verification…
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="field-error">
          Verification could not load. Refresh the page and try again.
        </p>
      )}
    </div>
  );
}

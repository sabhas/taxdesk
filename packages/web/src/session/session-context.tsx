import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { CurrentSession, PermissionKey } from '@taxdesk/shared';
import { ApiError, SESSION_EXPIRED_EVENT } from '../api-client.js';
import { fetchSession, logout as logoutRequest } from '../auth-client.js';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous'; readonly expired: boolean }
  | { readonly status: 'authenticated'; readonly session: CurrentSession }
  | {
      readonly status: 'error';
      readonly message: string;
      readonly requestId?: string | undefined;
    };

export interface SessionContextValue {
  readonly state: SessionState;
  readonly can: (permission: PermissionKey) => boolean;
  readonly adopt: (session: CurrentSession) => void;
  readonly refresh: () => void;
  readonly markAnonymous: (expired: boolean) => void;
  readonly signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

function loadMessage(error: unknown): { message: string; requestId?: string | undefined } {
  if (error instanceof ApiError) {
    return {
      message:
        error.status === 0
          ? 'We could not reach TaxDesk. Check your connection and try again.'
          : 'We could not load your session. Please try again.',
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return { message: 'We could not load your session. Please try again.' };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: 'loading' });

    void fetchSession(controller.signal)
      .then((session) => {
        if (active) {
          setState({ status: 'authenticated', session });
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setState({ status: 'anonymous', expired: error.code === 'SESSION_EXPIRED' });
          return;
        }
        setState({ status: 'error', ...loadMessage(error) });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey]);

  useEffect(() => {
    const onExpired = (): void => {
      setState({ status: 'anonymous', expired: true });
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    };
  }, []);

  const can = useCallback(
    (permission: PermissionKey): boolean =>
      state.status === 'authenticated' && state.session.permissions.includes(permission),
    [state],
  );

  const adopt = useCallback((session: CurrentSession) => {
    setState({ status: 'authenticated', session });
  }, []);

  const refresh = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  const markAnonymous = useCallback((expired: boolean) => {
    setState({ status: 'anonymous', expired });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // A failed logout request still ends the local session; the server-side
      // session is revoked by idle expiry or an explicit admin action.
    }
    setState({ status: 'anonymous', expired: false });
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ state, can, adopt, refresh, markAnonymous, signOut }),
    [state, can, adopt, refresh, markAnonymous, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === undefined) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }
  return value;
}

/**
 * Session state.
 *
 * Owns exactly one thing: whether the user is signed in, and the access token
 * that proves it. Everything else (forms, guards) reads from here.
 *
 * Why a context with an in-memory token rather than a cookie-only session:
 *
 *   * The access token is deliberately *not* a cookie. It is sent in an
 *     `Authorization` header, so a state-changing request cannot be forged by a
 *     cross-site form post, and it never touches `localStorage`.
 *   * The refresh cookie *is* HttpOnly and cannot be read here, so a reload
 *     cannot be distinguished from "never signed in" until a refresh is tried.
 *     That is why the provider boots in `restoring` rather than `anonymous`:
 *     rendering a login form and then swapping it for the app is the visible
 *     flash-of-wrong-state this avoids.
 *
 * Cross-tab consistency: `localStorage` holds a single non-secret flag, and a
 * `storage` event on it tells other tabs to re-check their session. Tabs cannot
 * share memory, so this is the only signal available — and it is intentionally
 * *not* the token.
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  AUTH_ROUTES,
  ACCESS_TOKEN_REFRESH_SKEW_MS,
  type SessionResponse,
} from '@socialhub/contracts';

import { ApiClient, isApiFailure, type ApiError } from './api-client';

/** The one key used for cross-tab signalling. Holds no credential. */
const SESSION_SIGNAL_KEY = 'socialhub.session';
const SESSION_SIGNAL_SIGNED_IN = 'in';

export type SessionStatus = 'restoring' | 'authenticated' | 'anonymous';

export type Session = {
  readonly user: SessionResponse['user'];
  readonly accessToken: string;
  readonly expiresAt: number;
};

type SessionContextValue = {
  readonly status: SessionStatus;
  readonly session: Session | null;
  readonly client: ApiClient;
  signIn: (response: SessionResponse) => void;
  signOut: (scope?: 'current' | 'all') => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * The API base URL.
 *
 * Empty in the browser: the web app proxies `/api/*` to the API (see the Next
 * rewrite), so requests are same-origin. That is required, not cosmetic —
 * `__Host-` cookies and `credentials: 'include'` both behave predictably only
 * where the browser sees one origin.
 */
const resolveBaseUrl = (): string => process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

export const SessionProvider = ({
  children,
  initialSession = null,
}: {
  children: ReactNode;
  /** Server-rendered sessions are not possible (no cookie access), so this is for tests. */
  initialSession?: Session | null;
}): React.JSX.Element => {
  const [status, setStatus] = useState<SessionStatus>(
    initialSession === null ? 'restoring' : 'authenticated',
  );
  const [session, setSession] = useState<Session | null>(initialSession);

  const sessionRef = useRef<Session | null>(initialSession);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const client = useMemo(
    () =>
      new ApiClient(resolveBaseUrl(), () => {
        sessionRef.current = null;
        setSession(null);
        setStatus('anonymous');
      }),
    [],
  );

  const applySession = useCallback(
    (response: SessionResponse) => {
      const next: Session = {
        user: response.user,
        accessToken: response.accessToken,
        expiresAt: new Date(response.accessTokenExpiresAt).getTime(),
      };
      sessionRef.current = next;
      setSession(next);
      setStatus('authenticated');
      client.setAccessToken(next.accessToken);

      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SESSION_SIGNAL_KEY, SESSION_SIGNAL_SIGNED_IN);
      }
    },
    [client],
  );

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    setSession(null);
    setStatus('anonymous');
    client.setAccessToken(null);

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(SESSION_SIGNAL_KEY);
    }
  }, [client]);

  /**
   * Proactive refresh, scheduled a minute before expiry.
   *
   * Reactive refresh (on a 401) alone would make one request per token lifetime
   * pay two round trips and would show a spinner for no reason. This keeps the
   * token fresh while the tab is open, and the reactive path remains as the
   * safety net for a sleeping laptop or a throttled background tab.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);

    const current = sessionRef.current;
    if (current === null) return;

    const delay = Math.max(current.expiresAt - Date.now() - ACCESS_TOKEN_REFRESH_SKEW_MS, 5_000);

    refreshTimer.current = setTimeout(() => {
      void client.refreshSession().then((ok) => {
        if (!ok) {
          clearSession();
          return;
        }
        const token = client.getAccessToken();
        const previous = sessionRef.current;
        if (token !== null && previous !== null) {
          // The server's expiry is authoritative; treat the local clock only as a
          // scheduling hint, and re-read it from the next actual response.
          const refreshed: Session = {
            ...previous,
            accessToken: token,
            expiresAt: Date.now() + 15 * 60_000,
          };
          sessionRef.current = refreshed;
          setSession(refreshed);
        }
        scheduleRefresh();
      });
    }, delay);
  }, [clearSession, client]);

  // Boot: try to restore from the HttpOnly refresh cookie exactly once.
  useEffect(() => {
    if (initialSession !== null) return;

    let cancelled = false;

    void client.refreshSession().then(async (ok) => {
      if (cancelled) return;

      if (!ok) {
        setStatus('anonymous');
        return;
      }

      const token = client.getAccessToken();
      if (token === null) {
        setStatus('anonymous');
        return;
      }

      // The refresh response carries the user; re-fetching `/me` here would be a
      // redundant round trip on every page load.
      try {
        const me = await client.request<SessionResponse['user']>(AUTH_ROUTES.me);
        if (cancelled) return;
        applySession({
          accessToken: token,
          accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
          user: me,
        });
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [applySession, client, initialSession]);

  useEffect(() => {
    if (status === 'authenticated') scheduleRefresh();
    return () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    };
  }, [scheduleRefresh, status]);

  // Another tab signed out: mirror it, so two tabs cannot disagree about identity.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== SESSION_SIGNAL_KEY) return;
      if (event.newValue === null) clearSession();
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [clearSession]);

  const signIn = useCallback(
    (response: SessionResponse) => {
      applySession(response);
    },
    [applySession],
  );

  const signOut = useCallback(
    async (scope: 'current' | 'all' = 'current') => {
      try {
        await client.request<void>(AUTH_ROUTES.logout, { method: 'POST', body: { scope } });
      } catch (error) {
        // Signing out must succeed locally even if the call fails: leaving the
        // token in memory because the network dropped is the worse outcome.
        if (isApiFailure(error as ApiError) || (error as ApiError).kind === 'network') {
          // fall through to local cleanup
        }
      } finally {
        clearSession();
      }
    },
    [clearSession, client],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ status, session, client, signIn, signOut }),
    [client, session, signIn, signOut, status],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = (): SessionContextValue => {
  const context = useContext(SessionContext);
  if (context === null) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return context;
};

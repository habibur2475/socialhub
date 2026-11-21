import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { SessionProvider, useSession } from './session';

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <SessionProvider>{children}</SessionProvider>
);

const sessionBody = {
  accessToken: 'access-token-1',
  accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
  user: { id: 'account-1', accountType: 'USER' as const, permissions: [] },
};

describe('session provider', () => {
  beforeEach(() => {
    document.cookie = '__Host-sh_csrf=csrf-value; Secure; Path=/';
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Booting straight to "anonymous" would render a sign-in button and then swap
   * it for an avatar — the flash-of-wrong-state the provider exists to prevent. A
   * reload cannot be distinguished from "never signed in" until the refresh
   * attempt completes, so the only honest initial state is "restoring".
   */
  it('starts in the restoring state, not anonymous', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.status).toBe('restoring');
  });

  it('settles on anonymous when there is no session to restore', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    const { result } = renderHook(() => useSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('anonymous');
    });
    expect(result.current.session).toBeNull();
  });

  it('restores a session from the refresh cookie and loads the identity', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('refresh')) {
        return new Response(JSON.stringify({ accessToken: 'restored-token' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: 'account-9', accountType: 'USER', permissions: ['post:read'] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.status).toBe('authenticated');
    });
    expect(result.current.session?.accessToken).toBe('restored-token');
    expect(result.current.session?.user.id).toBe('account-9');
  });

  it('signs in by storing the token in memory only — never in localStorage', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    const { result } = renderHook(() => useSession(), { wrapper });

    act(() => {
      result.current.signIn(sessionBody);
    });

    expect(result.current.client.getAccessToken()).toBe('access-token-1');

    // The localStorage flag is a cross-tab signal, not a credential. If the token
    // ever appears here, a single XSS bug becomes a credential that survives reload.
    const stored = Object.values(window.localStorage).join(' ');
    expect(stored).not.toContain('access-token-1');
    expect(window.localStorage.getItem('socialhub.session')).toBe('in');
  });

  it('clears memory and the cross-tab signal on sign-out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(null, { status: 204 })),
    );

    const { result } = renderHook(() => useSession(), { wrapper });

    act(() => {
      result.current.signIn(sessionBody);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(result.current.status).toBe('anonymous');
    expect(result.current.session).toBeNull();
    expect(result.current.client.getAccessToken()).toBeNull();
    expect(window.localStorage.getItem('socialhub.session')).toBeNull();
  });

  /**
   * Signing out must succeed locally even when the call fails. Leaving a token in
   * memory because the network dropped is strictly worse than a stale server-side
   * session, which expires on its own.
   */
  it('still signs out locally when the server call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    const { result } = renderHook(() => useSession(), { wrapper });

    act(() => {
      result.current.signIn(sessionBody);
    });

    await act(async () => {
      await result.current.signOut();
    });

    expect(result.current.status).toBe('anonymous');
    expect(result.current.client.getAccessToken()).toBeNull();
  });

  it('mirrors a sign-out performed in another tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));

    const { result } = renderHook(() => useSession(), { wrapper });

    act(() => {
      result.current.signIn(sessionBody);
    });

    // A `storage` event with a null value is what another tab's removal emits.
    act(() => {
      window.localStorage.removeItem('socialhub.session');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'socialhub.session', newValue: null }),
      );
    });

    expect(result.current.status).toBe('anonymous');
    expect(result.current.client.getAccessToken()).toBeNull();
  });
});

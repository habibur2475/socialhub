'use client';

/**
 * Registers the service worker, and only in production.
 *
 * In development Next.js serves chunks from memory with unstable URLs and hot
 * reloads constantly; a service worker caching those produces "why is my change
 * not showing" for an afternoon. `NODE_ENV` is checked at build time, so the
 * development bundle does not even contain the registration call.
 *
 * Registration is deferred to `load` so it can never compete with first paint for
 * the main thread — the worker is useful on the *next* visit, not this one.
 */

import { useEffect } from 'react';

export const ServiceWorkerRegistrar = (): null => {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // Registration failure is not user-facing: the app works without it.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
};

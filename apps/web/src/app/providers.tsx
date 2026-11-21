'use client';

/**
 * Client-side providers.
 *
 * Kept in one module so the root layout can remain a server component. Only the
 * session provider is here for now; the query client joins it when data fetching
 * lands, and keeping the boundary in one place means the layout never has to
 * become `'use client'` and pull the whole tree into the client bundle.
 */

import type { ReactNode } from 'react';

import { ServiceWorkerRegistrar } from '@/components/pwa/service-worker-registrar';
import { NotificationProvider } from '@/lib/notifications';
import { SessionProvider } from '@/lib/session';

export const Providers = ({ children }: { readonly children: ReactNode }): React.JSX.Element => (
  <SessionProvider>
    {/*
      The notification provider sits *inside* the session provider because it needs
      the authenticated client to open its stream, and *outside* the app shell so the
      badge can render in the header on every page.
    */}
    <NotificationProvider>
      {children}
      <ServiceWorkerRegistrar />
    </NotificationProvider>
  </SessionProvider>
);

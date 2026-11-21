import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Providers } from './providers';

const APP_NAME = 'SocialHub';
const APP_DESCRIPTION =
  'Social, messaging, learning, marketplace, and work — one platform, built to scale.';

export const metadata: Metadata = {
  applicationName: APP_NAME,
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_DESCRIPTION,
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192' }],
  },
  appleWebApp: {
    capable: true,
    title: APP_NAME,
    // `black-translucent` lets the app paint under the status bar, which is what
    // makes an installed PWA feel native rather than a web page in a frame.
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never disable zoom: pinch-zoom is an accessibility requirement (WCAG 1.4.4),
  // and `user-scalable=no` is the single most common mobile accessibility failure.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020617' },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * This is an inline blocking script, and that is deliberate: any theme logic that
 * runs after paint produces a white flash for every dark-mode user on every load.
 * It is a few dozen bytes and touches storage plus one attribute — no secret, no
 * network, nothing that needs to be a module.
 */
const themeBootScript = `
try {
  var stored = localStorage.getItem('socialhub.theme');
  var dark = stored === 'dark' || ((stored === null || stored === 'system')
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (error) {
  document.documentElement.dataset.theme = 'light';
}
`;

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

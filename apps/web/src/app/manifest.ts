import type { MetadataRoute } from 'next';

/**
 * Web app manifest, served at `/manifest.webmanifest`.
 *
 * `display: 'standalone'` rather than `fullscreen`: fullscreen hides the OS status
 * bar, so the user loses the clock and battery indicator with no way to get them
 * back. Standalone keeps the app looking native while leaving the user in control.
 *
 * Icons are declared with `purpose: 'any'` and a separate `maskable` entry.
 * A single icon cannot serve both: an Android home screen crops a maskable icon to
 * whatever shape the launcher uses, and reusing the `any` icon there clips the logo.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SocialHub',
    short_name: 'SocialHub',
    description: 'Social, messaging, learning, marketplaces, and work in one account.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f8fafc',
    theme_color: '#f8fafc',
    categories: ['social', 'productivity', 'education'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Messages', url: '/messages' },
      { name: 'Create a post', url: '/social/new' },
    ],
  };
}

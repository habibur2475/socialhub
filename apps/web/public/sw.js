/**
 * Service worker.
 *
 * Deliberately small. A service worker sits between the user and the network, so
 * a bug here is not a broken page — it is a broken app that persists after the
 * bug is fixed. Scope is therefore limited to what a PWA actually needs:
 *
 *   1. Offline shell — navigations fall back to a cached page.
 *   2. Static asset caching — hashed Next.js chunks are immutable, so caching
 *      them is free correctness.
 *
 * What it deliberately does NOT do:
 *
 *   * Cache API responses. Session data, feeds and permissions must never be
 *     served from a cache: showing one user another's cached feed is the classic
 *     shared-device leak, and a stale permission mask is a security bug.
 *   * Cache HTML previews of authenticated routes. The offline page is static.
 *   * Use `cacheFirst` for documents. A stale document means a user keeps
 *     running last week's JavaScript against this week's API.
 */

const VERSION = 'v1';
const SHELL_CACHE = `socialhub-shell-${VERSION}`;
const STATIC_CACHE = `socialhub-static-${VERSION}`;
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll([OFFLINE_URL]);
      // Take over immediately: a new deploy should not wait for every tab to close.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete every cache from a previous version, so an old shell cannot
      // resurrect after an update.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== STATIC_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and only same-origin. Proxying third-party requests
  // through a service worker is how opaque-response bugs happen.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never touch the API. A cached 401 or a cached feed is worse than no cache.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirstStatic(request));
  }
});

/**
 * Network-first for documents: the user gets fresh HTML whenever the network
 * works, and a static offline page when it does not. Never a stale document.
 */
async function networkFirstDocument(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const fallback = await cache.match(OFFLINE_URL);
    return (
      fallback ??
      new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
    );
  }
}

/**
 * Cache-first for immutable assets. Next.js fingerprints these paths, so a file
 * at a given URL can never change — revalidating it would waste the round trip.
 */
async function cacheFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

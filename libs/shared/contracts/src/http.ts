/**
 * Transport constants shared by the server and the browser.
 *
 * These are not configuration: they are part of the protocol. The server sets the
 * CSRF header name and the cookies below, and the browser must echo exactly those
 * names. Duplicating the strings would make a typo a silent 403, so both sides
 * import from here.
 */

/** Versioned prefix for every resource endpoint. */
export const API_PREFIX = '/api/v1';

export const AUTH_ROUTES = {
  register: `${API_PREFIX}/auth/register`,
  verifyEmail: `${API_PREFIX}/auth/verify-email`,
  login: `${API_PREFIX}/auth/login`,
  refresh: `${API_PREFIX}/auth/refresh`,
  logout: `${API_PREFIX}/auth/logout`,
  me: `${API_PREFIX}/auth/me`,
  forgotPassword: `${API_PREFIX}/auth/password/forgot`,
  resetPassword: `${API_PREFIX}/auth/password/reset`,
} as const;

/**
 * Health probes deliberately sit outside the versioned surface: an orchestrator
 * must not need to know the API version, and these paths must never change.
 */
export const HEALTH_ROUTES = {
  live: '/health/live',
  ready: '/health/ready',
} as const;

/**
 * `__Host-` prefix: the browser refuses to send these cookies unless they are
 * Secure, have no Domain, and use Path=/. That makes them unforgeable by a
 * sibling subdomain, which is the point.
 */
export const REFRESH_COOKIE_NAME = '__Host-sh_rt';
export const CSRF_COOKIE_NAME = '__Host-sh_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * `Path=/`, because the `__Host-` prefix *requires* it.
 *
 * The tempting alternative — scoping this cookie to `/api/v1/auth` — is silently rejected by
 * every browser: a `__Host-` cookie whose path is not `/` is dropped, so the session appears
 * to work until the first reload and then quietly disappears. The prefix buys more (a cookie
 * no sibling subdomain and no subpath can forge) than the narrower path would, and the
 * cookie is `HttpOnly` besides.
 */
export const REFRESH_COOKIE_PATH = '/';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Access tokens are held in memory for this long before a proactive refresh. */
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

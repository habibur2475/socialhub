/**
 * Typed HTTP client.
 *
 * Three decisions worth defending:
 *
 * 1. **The access token lives in memory, never in `localStorage`.** Anything in
 *    localStorage is readable by any script that gets onto the page, so a single
 *    XSS bug becomes a stolen credential that survives a reload. In memory it dies
 *    with the tab, and the HttpOnly refresh cookie is the only persisted secret —
 *    which JavaScript cannot read at all.
 *
 * 2. **A single-flight refresh.** When five requests fail on an expired token at
 *    once, they must share one refresh call. Firing five would rotate the token
 *    five times and trip the server's reuse detection, logging the user out for
 *    doing nothing wrong.
 *
 * 3. **Errors are typed, not thrown strings.** A UI needs to distinguish "wrong
 *    password" (show under the field) from "rate limited" (show a banner) from
 *    "offline" (offer a retry) — and it needs the trace id to quote in a support
 *    report.
 */

import {
  AUTH_ROUTES,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REQUEST_ID_HEADER,
  validationIssuesOf,
  type ApiErrorBody,
  type ValidationIssue,
} from '@socialhub/contracts';
import type { ErrorCode } from '@socialhub/kernel/browser';

export type ApiFailure = {
  readonly kind: 'api';
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly traceId: string;
  readonly issues: readonly ValidationIssue[];
};

export type NetworkFailure = {
  readonly kind: 'network';
  readonly message: string;
};

export type ApiError = ApiFailure | NetworkFailure;

/**
 * Narrows a caught value to a typed API failure.
 *
 * The parameter is `unknown`, not `ApiError`: a `catch` clause yields `unknown`
 * under strict settings, and a guard that demands its input already be the thing
 * it is proving is useless at the only call site that matters.
 */
export const isApiFailure = (error: unknown): error is ApiFailure => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { kind?: unknown; code?: unknown; status?: unknown };
  return (
    candidate.kind === 'api' &&
    typeof candidate.code === 'string' &&
    typeof candidate.status === 'number'
  );
};

/** Cookie reads are browser-only; SSR has no `document`. */
const readCsrfToken = (): string | undefined => {
  if (typeof document === 'undefined') return undefined;

  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE_NAME}=`));

  if (match === undefined) return undefined;

  const value = match.slice(CSRF_COOKIE_NAME.length + 1);
  return value.length === 0 ? undefined : decodeURIComponent(value);
};

const toApiFailure = async (response: Response): Promise<ApiFailure> => {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = undefined;
  }

  const code = body?.error.code ?? 'INTERNAL_ERROR';
  return {
    kind: 'api',
    status: response.status,
    code,
    message: body?.error.message ?? 'Something went wrong. Please try again.',
    traceId: body?.error.traceId ?? '',
    issues: body === undefined ? [] : validationIssuesOf(body),
  };
};

export type RequestOptions = {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Overrides the in-memory access token for this call only. */
  readonly accessToken?: string | null;
};

export class ApiClient {
  private accessToken: string | null = null;
  /** In-flight refresh, shared by every caller that hits it concurrently. */
  private refreshInFlight: Promise<boolean> | null = null;

  public constructor(
    private readonly baseUrl: string,
    /** Called when the session is unrecoverable, so the shell can redirect once. */
    private readonly onSessionLost: () => void = () => undefined,
  ) {}

  public setAccessToken(token: string | null): void {
    this.accessToken = token;
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Refreshes the session, coalescing concurrent callers.
   *
   * Returns whether the session survived. It never throws: every caller is
   * mid-request and needs a boolean, not a second failure mode.
   */
  public async refreshSession(): Promise<boolean> {
    if (this.refreshInFlight !== null) return this.refreshInFlight;

    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });

    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<boolean> {
    const csrf = readCsrfToken();
    if (csrf === undefined) {
      // No CSRF cookie means no session was ever established here, so there is
      // nothing to refresh and no point asking the server.
      this.accessToken = null;
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}${AUTH_ROUTES.refresh}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          [CSRF_HEADER_NAME]: csrf,
          'content-type': 'application/json',
        },
        body: '{}',
      });

      if (!response.ok) {
        this.accessToken = null;
        return false;
      }

      const session = (await response.json()) as { accessToken: string };
      this.accessToken = session.accessToken;
      return true;
    } catch {
      // A network blip is not a logout. Keep the token and let the caller decide;
      // retrying on reconnect is handled by the query layer.
      return this.accessToken !== null;
    }
  }

  /** Authenticated request. Retries exactly once, after a successful refresh. */
  public async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const first = await this.attempt<T>(path, options, false);
    if (first.ok) return first.value;
    if (!first.retryable) throw first.error;

    const refreshed = await this.refreshSession();
    if (!refreshed) {
      this.onSessionLost();
      throw first.error;
    }

    const second = await this.attempt<T>(path, options, true);
    if (second.ok) return second.value;
    throw second.error;
  }

  /** Unauthenticated request (login, register, reset). Never triggers a refresh. */
  public async publicRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const result = await this.attempt<T>(path, options, false, false);
    if (result.ok) return result.value;
    throw result.error;
  }

  private async attempt<T>(
    path: string,
    options: RequestOptions,
    isRetry: boolean,
    authenticated = true,
  ): Promise<{ ok: true; value: T } | { ok: false; error: ApiError; retryable: boolean }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const token = options.accessToken ?? this.accessToken;
    if (authenticated && token !== null && token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }

    // The refresh endpoint authenticates with a cookie plus this header.
    const csrf = readCsrfToken();
    if (csrf !== undefined && path === AUTH_ROUTES.refresh) headers[CSRF_HEADER_NAME] = csrf;

    // Correlate this request with the server's log line, so a user-reported error
    // can be found without guessing from the timestamp.
    headers[REQUEST_ID_HEADER] = crypto.randomUUID();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        credentials: 'include',
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      return {
        ok: false,
        retryable: false,
        error: {
          kind: 'network',
          message:
            cause instanceof Error && cause.name === 'AbortError'
              ? 'Request cancelled.'
              : 'Cannot reach the server. Check your connection.',
        },
      };
    }

    if (response.ok) {
      // 204 has no body; returning `undefined` as T is the honest representation.
      if (response.status === 204) return { ok: true, value: undefined as T };
      return { ok: true, value: (await response.json()) as T };
    }

    const error = await toApiFailure(response);

    // A 401 on an authenticated call is the one case worth retrying, and only
    // once — a second 401 after a fresh token is a real authorisation failure.
    const retryable = authenticated && !isRetry && response.status === 401;

    return { ok: false, error, retryable };
  }
}

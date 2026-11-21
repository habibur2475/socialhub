import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, isApiFailure } from './api-client';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('ApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The CSRF token is read from a cookie; jsdom persists document.cookie.
    document.cookie = '__Host-sh_csrf=csrf-token-value; Secure; Path=/';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new ApiClient('');

    await expect(client.publicRequest<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });
  });

  it('sends the access token only when one has been set', async () => {
    // A fresh Response per call: a body can only be read once, so a shared
    // mock object would fail on the second request for the wrong reason.
    fetchMock.mockImplementation(async () => jsonResponse(200, {}));
    const client = new ApiClient('');

    await client.request('/x');
    expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBeUndefined();

    client.setAccessToken('token-abc');
    await client.request('/x');
    expect(fetchMock.mock.calls[1]?.[1]?.headers.authorization).toBe('Bearer token-abc');
  });

  it('always asks for credentials, so the refresh cookie is sent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await new ApiClient('').publicRequest('/x');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');
  });

  it('sends a correlation id so a report can be matched to a server log line', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await new ApiClient('').publicRequest('/x');
    expect(fetchMock.mock.calls[0]?.[1]?.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('maps a typed error body onto a structured failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          traceId: 'trace-1',
          details: {
            issues: [{ path: 'email', message: 'Enter a valid email address' }],
          },
        },
      }),
    );

    const failure = await new ApiClient('').publicRequest('/x').catch((error: unknown) => error);

    expect(isApiFailure(failure)).toBe(true);
    if (!isApiFailure(failure)) throw new Error('unreachable');
    expect(failure.status).toBe(422);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.issues).toEqual([{ path: 'email', message: 'Enter a valid email address' }]);
  });

  it('never throws a raw body when the error is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    const failure = await new ApiClient('').publicRequest('/x').catch((error: unknown) => error);
    if (!isApiFailure(failure)) throw new Error('expected an ApiFailure');
    expect(failure.code).toBe('INTERNAL_ERROR');
    expect(failure.message).not.toContain('html');
  });

  it('reports a network failure without pretending it was an API error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const failure = await new ApiClient('').publicRequest('/x').catch((error: unknown) => error);
    expect(failure).toEqual({ kind: 'network', message: expect.stringContaining('Cannot reach') });
  });

  it('retries once after refreshing on a 401', async () => {
    const client = new ApiClient('');
    client.setAccessToken('stale');

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { code: 'SESSION_EXPIRED', message: 'x', traceId: 't' } }),
      )
      // The refresh call.
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh' }))
      // The retried request.
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(client.request<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.headers.authorization).toBe('Bearer fresh');
  });

  it('gives up after one retry, so a real authorisation failure is not retried forever', async () => {
    const client = new ApiClient('');
    client.setAccessToken('stale');

    const unauthorised = jsonResponse(401, {
      error: { code: 'UNAUTHENTICATED', message: 'no', traceId: 't' },
    });

    fetchMock
      .mockResolvedValueOnce(unauthorised)
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh' }))
      .mockResolvedValueOnce(unauthorised);

    await expect(client.request('/x')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /**
   * The bug this prevents: five parallel requests expire at once, fire five
   * refreshes, rotate the token five times, and trip the server's reuse
   * detection — signing the user out for doing nothing wrong.
   */
  it('coalesces concurrent refreshes into a single call', async () => {
    const client = new ApiClient('');
    fetchMock.mockImplementation(async () => jsonResponse(200, { accessToken: 'fresh' }));

    const results = await Promise.all([
      client.refreshSession(),
      client.refreshSession(),
      client.refreshSession(),
      client.refreshSession(),
    ]);

    expect(results).toEqual([true, true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails the refresh without a call when no CSRF cookie exists', async () => {
    document.cookie = '__Host-sh_csrf=; Secure; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    const client = new ApiClient('');

    await expect(client.refreshSession()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the token when a refresh fails on the network, because that is not a logout', async () => {
    const client = new ApiClient('');
    client.setAccessToken('still-valid');

    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(client.refreshSession()).resolves.toBe(true);
  });

  it('handles a 204 with no body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      new ApiClient('').request<void>('/x', { method: 'POST' }),
    ).resolves.toBeUndefined();
  });
});

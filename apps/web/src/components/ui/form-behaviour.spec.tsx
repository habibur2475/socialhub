import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginForm } from '@/app/(auth)/login/login-form';
import { SessionProvider } from '@/lib/session';

const renderLogin = (props: { notice?: string; next?: string } = {}): void => {
  render(
    <SessionProvider>
      <LoginForm notice={props.notice} next={props.next} />
    </SessionProvider>,
  );
};

describe('login form', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The accessibility contract, asserted rather than assumed: a label bound to
   * the input, and no placeholder standing in for it. If someone later "tidies"
   * the form into placeholder-only inputs, this fails.
   */
  it('binds a real label to every input and uses no placeholder labels', () => {
    renderLogin();

    const email = screen.getByLabelText(/^Email/) as HTMLInputElement;
    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;

    expect(email.id).toBe('email');
    expect(password.id).toBe('password');
    expect(email.getAttribute('placeholder')).toBeNull();
    expect(password.getAttribute('placeholder')).toBeNull();
  });

  it('gives the inputs the autocomplete hints a password manager needs', () => {
    renderLogin();
    expect(screen.getByLabelText(/^Email/).getAttribute('autocomplete')).toBe('email');
    expect(screen.getByLabelText(/^Password/).getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });

  it('does not validate on the first keystroke, only after the field is left', async () => {
    renderLogin();
    const email = screen.getByLabelText(/^Email/);

    fireEvent.change(email, { target: { value: 'a' } });
    // Typing the first character of an address would otherwise produce an
    // immediate, wrong "invalid email" message.
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.blur(email);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('valid email');
    });
  });

  it('announces a rejected field and marks it invalid', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(screen.getByLabelText(/^Email/).getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the server message when the credentials are wrong', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Email or password is incorrect',
            traceId: 'trace-1',
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );

    renderLogin();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Email or password is incorrect');
    });
  });

  /**
   * A 422 from the server must land under the field the user has to fix, not in
   * a generic banner — otherwise they have to guess which input is wrong.
   */
  it('places a server field error under that field', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            traceId: 'trace-2',
            details: {
              issues: [{ path: 'email', message: 'Enter a valid email address' }],
            },
          },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );

    renderLogin();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'some-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByLabelText(/^Email/).getAttribute('aria-invalid')).toBe('true');
    });
  });

  it('explains an unverified account instead of repeating a generic failure', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Please verify your email address to continue.',
            traceId: 'trace-3',
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );

    renderLogin();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'some-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Verify your email first');
    });
  });

  it('renders the post-registration notice so the user knows why they are here', () => {
    renderLogin({ notice: 'registered' });
    expect(screen.getByText(/Account created/i)).toBeTruthy();
  });

  it('marks the submit button busy while the request is in flight', async () => {
    // A promise that never settles: the assertion is about the intermediate state.
    vi.mocked(fetch).mockImplementation(() => new Promise(() => undefined));

    renderLogin();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'ada@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'some-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Signing in/ });
      expect(button.getAttribute('aria-busy')).toBe('true');
      // Disabled is what actually prevents a double submission.
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

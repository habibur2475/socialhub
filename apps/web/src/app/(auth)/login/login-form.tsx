'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { AUTH_ROUTES, loginRequestSchema, type SessionResponse } from '@socialhub/contracts';

import { Button } from '@/components/ui/button';
import { FormError, FormNotice, TextField } from '@/components/ui/field';
import {
  describeError,
  fieldsFromApi,
  fieldsFromZod,
  useSubmitState,
  validateField,
} from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { useSession } from '@/lib/session';

type FieldName = 'email' | 'password';

/**
 * Actionable copy for the codes a sign-in attempt can return. Anything absent
 * falls back to the server's own message, which is already written for users.
 */
const GUIDANCE: Partial<Record<string, string>> = {
  EMAIL_NOT_VERIFIED: 'Verify your email first — the 6-digit code is in your inbox.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again in a few minutes.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Contact support if you believe this is a mistake.',
  RATE_LIMITED: 'Too many attempts from this network. Please wait a moment.',
};

/**
 * Only same-origin paths are honoured after sign-in. Accepting an absolute URL
 * would turn this form into an open redirect, which is exactly how a phishing
 * campaign borrows a real domain's login page.
 */
const safeNext = (next: string | undefined): string => {
  if (next === undefined) return '/feed';
  if (!next.startsWith('/') || next.startsWith('//')) return '/feed';
  return next;
};

export const LoginForm = ({
  notice,
  next,
}: {
  readonly notice: string | undefined;
  readonly next: string | undefined;
}): React.JSX.Element => {
  const router = useRouter();
  const { client, signIn } = useSession();
  const { state, start, fail, succeed, setFieldError } = useSubmitState();

  const [values, setValues] = useState<Record<FieldName, string>>({ email: '', password: '' });
  const [touched, setTouched] = useState<Record<FieldName, boolean>>({
    email: false,
    password: false,
  });

  const update = (field: FieldName, value: string): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
  };

  /** Marks the field as visited and validates just it, with the shared schema. */
  const blur = (field: FieldName): void => {
    setTouched((previous) => ({ ...previous, [field]: true }));
    const message = validateField(loginRequestSchema, values, field);
    setFieldError(field, message);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    start();

    // Submitting is the clearest signal that the user has visited every field, so
    // errors from this attempt must not be suppressed by the "not blurred yet"
    // rule — otherwise a server-side field error would be invisible.
    setTouched({ email: true, password: true });

    const parsed = loginRequestSchema.safeParse(values);
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    try {
      const session = await client.publicRequest<SessionResponse>(AUTH_ROUTES.login, {
        method: 'POST',
        body: parsed.data,
      });
      signIn(session);
      succeed();
      router.replace(safeNext(next));
    } catch (error) {
      if (isApiFailure(error)) {
        const mapped = fieldsFromApi(error);
        // A code-specific message wins over the server's generic wording: "verify
        // your email" tells the user what to do next, while "please verify your
        // email address to continue" repeats what they already read.
        fail({
          fields: mapped.fields,
          form: mapped.form === null ? null : (GUIDANCE[error.code] ?? error.message),
        });
        return;
      }
      fail({ form: describeError(error) });
    }
  };

  return (
    <div className="flex flex-col gap-lg rounded-lg border border-border bg-surface p-lg shadow-md">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading">Sign in</h1>
        <p className="text-small text-muted">Welcome back. Enter your details to continue.</p>
      </header>

      {notice === 'registered' ? (
        <FormNotice>Account created. Check your inbox for a 6-digit code, then sign in.</FormNotice>
      ) : null}
      {notice === 'reset' ? (
        <FormNotice>Password updated. Sign in with your new password.</FormNotice>
      ) : null}
      {notice === 'expired' ? (
        <FormNotice>Your session ended. Please sign in again.</FormNotice>
      ) : null}

      {state.formError !== null ? <FormError>{state.formError}</FormError> : null}

      <form onSubmit={submit} noValidate className="flex flex-col gap-md">
        <TextField
          label="Email"
          htmlFor="email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={values.email}
          onChange={(event) => update('email', event.target.value)}
          onBlur={() => blur('email')}
          error={touched.email ? state.fieldErrors['email'] : undefined}
        />

        <div className="flex flex-col gap-xs">
          <TextField
            label="Password"
            htmlFor="password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={values.password}
            onChange={(event) => update('password', event.target.value)}
            onBlur={() => blur('password')}
            error={touched.password ? state.fieldErrors['password'] : undefined}
          />
          <Link
            href="/forgot-password"
            className="self-end text-caption text-primary hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" fullWidth loading={state.submitting}>
          {state.submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="text-center text-small text-muted">
        No account yet?{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
};

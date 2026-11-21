'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { requestPasswordResetRequestSchema, type MessageResponse } from '@socialhub/contracts';

import { Button } from '@/components/ui/button';
import { FormError, FormNotice, TextField } from '@/components/ui/field';
import { describeError, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { useSession } from '@/lib/session';

export default function ForgotPasswordPage(): React.JSX.Element {
  const { client } = useSession();
  const { state, start, fail, succeed } = useSubmitState();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    start();

    const parsed = requestPasswordResetRequestSchema.safeParse({ email });
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    try {
      await client.publicRequest<MessageResponse>('/api/v1/auth/password/forgot', {
        method: 'POST',
        body: parsed.data,
      });
      succeed();
      // The response is identical whether or not the account exists — that is the
      // whole point — so the next screen must not imply one outcome or the other.
      setSent(true);
    } catch (error) {
      if (isApiFailure(error)) {
        fail({ form: error.message });
        return;
      }
      fail({ form: describeError(error) });
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-md rounded-lg border border-border bg-surface p-lg shadow-md">
        <h1 className="text-heading">Check your inbox</h1>
        <FormNotice>
          If an account exists for {email}, a 6-digit reset code is on its way.
        </FormNotice>
        <Link
          href={`/reset-password?email=${encodeURIComponent(email)}`}
          className="text-center text-small font-medium text-primary hover:underline"
        >
          I have a code
        </Link>
        <Link href="/login" className="text-center text-small text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg rounded-lg border border-border bg-surface p-lg shadow-md">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading">Reset your password</h1>
        <p className="text-small text-muted">
          Enter your email and we will send a code to confirm it is you.
        </p>
      </header>

      {state.formError !== null ? <FormError>{state.formError}</FormError> : null}

      <form onSubmit={submit} noValidate className="flex flex-col gap-md">
        <TextField
          label="Email"
          htmlFor="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={state.fieldErrors['email']}
        />

        <Button type="submit" size="lg" fullWidth loading={state.submitting}>
          {state.submitting ? 'Sending…' : 'Send reset code'}
        </Button>
      </form>

      <Link href="/login" className="text-center text-small text-primary hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}

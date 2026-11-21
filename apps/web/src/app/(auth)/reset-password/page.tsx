'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { resetPasswordRequestSchema, type MessageResponse } from '@socialhub/contracts';

import { Button } from '@/components/ui/button';
import { FormError, TextField } from '@/components/ui/field';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const CODE_LENGTH = 6;

const ResetForm = (): React.JSX.Element => {
  const router = useRouter();
  const params = useSearchParams();
  const { client, signOut } = useSession();
  const { state, start, fail, succeed } = useSubmitState();

  const [email, setEmail] = useState(params.get('email') ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    start();

    const parsed = resetPasswordRequestSchema.safeParse({ email, code, password });
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    try {
      await client.publicRequest<MessageResponse>('/api/v1/auth/password/reset', {
        method: 'POST',
        body: parsed.data,
      });
      succeed();
      // A reset revokes every session on the server; clearing local state too
      // means this tab cannot keep using a token that is already dead.
      await signOut('all');
      router.replace('/login?notice=reset');
    } catch (error) {
      if (isApiFailure(error)) {
        const mapped = fieldsFromApi(error);
        fail({ fields: mapped.fields, form: mapped.form });
        return;
      }
      fail({ form: describeError(error) });
    }
  };

  return (
    <div className="flex flex-col gap-lg rounded-lg border border-border bg-surface p-lg shadow-md">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading">Choose a new password</h1>
        <p className="text-small text-muted">Enter the code we sent you and a new password.</p>
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
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={state.fieldErrors['email']}
        />

        <TextField
          label="Reset code"
          htmlFor="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={CODE_LENGTH}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
          error={state.fieldErrors['code']}
          hint="The 6-digit code from your inbox."
        />

        <TextField
          label="New password"
          htmlFor="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={state.fieldErrors['password']}
          hint="At least 10 characters. Longer is stronger than complicated."
        />

        <Button type="submit" size="lg" fullWidth loading={state.submitting}>
          {state.submitting ? 'Updating…' : 'Update password'}
        </Button>
      </form>

      <Link href="/login" className="text-center text-small text-primary hover:underline">
        Back to sign in
      </Link>
    </div>
  );
};

export default function ResetPasswordPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-md rounded-lg border border-border bg-surface p-lg">
          <div className="skeleton h-8 w-52" />
          <div className="skeleton h-11 w-full" />
          <div className="skeleton h-11 w-full" />
          <div className="skeleton h-12 w-full" />
        </div>
      }
    >
      <ResetForm />
    </Suspense>
  );
}

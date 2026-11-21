'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { verifyEmailRequestSchema, type VerifyEmailResponse } from '@socialhub/contracts';

import { Button } from '@/components/ui/button';
import { FormError, FormNotice, TextField } from '@/components/ui/field';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const CODE_LENGTH = 6;

const VerifyForm = (): React.JSX.Element => {
  const router = useRouter();
  const params = useSearchParams();
  const { client } = useSession();
  const { state, start, fail, succeed } = useSubmitState();

  const email = params.get('email') ?? '';
  const [code, setCode] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    start();

    const parsed = verifyEmailRequestSchema.safeParse({ email, code });
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    try {
      await client.publicRequest<VerifyEmailResponse>('/api/v1/auth/verify-email', {
        method: 'POST',
        body: parsed.data,
      });
      succeed();
      router.replace('/login?notice=registered');
    } catch (error) {
      if (isApiFailure(error)) {
        const mapped = fieldsFromApi(error);
        fail({ fields: mapped.fields, form: mapped.form });
        return;
      }
      fail({ form: describeError(error) });
    }
  };

  if (email.length === 0) {
    return (
      <div className="flex flex-col gap-md rounded-lg border border-border bg-surface p-lg">
        <h1 className="text-heading">Verify your email</h1>
        <FormNotice>
          Open the verification link from your inbox, or{' '}
          <Link href="/register" className="font-medium text-primary hover:underline">
            create an account
          </Link>
          .
        </FormNotice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg rounded-lg border border-border bg-surface p-lg shadow-md">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading">Check your inbox</h1>
        <p className="text-small text-muted">
          We sent a 6-digit code to <span className="font-medium text-text">{email}</span>.
        </p>
      </header>

      {state.formError !== null ? <FormError>{state.formError}</FormError> : null}

      <form onSubmit={submit} noValidate className="flex flex-col gap-md">
        <TextField
          label="Verification code"
          htmlFor="code"
          name="code"
          // `inputMode=numeric` opens the number pad; `autoComplete=one-time-code`
          // lets iOS and Android offer the code straight from the notification.
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={CODE_LENGTH}
          required
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
          error={state.fieldErrors['code']}
          hint="Digits only. The code expires in 10 minutes."
          className="text-center text-heading tracking-[0.4em]"
        />

        <Button
          type="submit"
          size="lg"
          fullWidth
          loading={state.submitting}
          disabled={code.length !== CODE_LENGTH}
        >
          {state.submitting ? 'Verifying…' : 'Verify email'}
        </Button>
      </form>

      <p className="text-center text-small text-muted">
        Wrong address?{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          Start over
        </Link>
      </p>
    </div>
  );
};

export default function VerifyEmailPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-md rounded-lg border border-border bg-surface p-lg">
          <div className="skeleton h-8 w-48" />
          <div className="skeleton h-11 w-full" />
          <div className="skeleton h-12 w-full" />
        </div>
      }
    >
      <VerifyForm />
    </Suspense>
  );
}

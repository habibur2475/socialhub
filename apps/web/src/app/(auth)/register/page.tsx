'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';

import { registerRequestSchema, type RegisteredResponse } from '@socialhub/contracts';

import { Button } from '@/components/ui/button';
import { FormError, TextField } from '@/components/ui/field';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { useSession } from '@/lib/session';

type FieldName = 'email' | 'password' | 'username' | 'displayName';

const FIELDS: ReadonlyArray<{
  name: FieldName;
  label: string;
  type: string;
  autoComplete: string;
  hint?: string;
  inputMode?: 'email' | 'text';
}> = [
  {
    name: 'displayName',
    label: 'Display name',
    type: 'text',
    autoComplete: 'name',
    hint: 'How your name appears to others.',
  },
  {
    name: 'username',
    label: 'Username',
    type: 'text',
    autoComplete: 'username',
    hint: '3–30 characters: lowercase letters, numbers, underscores.',
  },
  {
    name: 'email',
    label: 'Email',
    type: 'email',
    autoComplete: 'email',
    inputMode: 'email',
  },
  {
    name: 'password',
    label: 'Password',
    type: 'password',
    autoComplete: 'new-password',
    hint: 'At least 10 characters. Longer is stronger than complicated.',
  },
];

/**
 * Password strength as a description, not a score.
 *
 * "Strong" with no reason teaches nothing. Each label names what would improve
 * the password, which is the only feedback that changes behaviour. Length is the
 * dominant factor because that is what entropy actually follows.
 */
const describePassword = (password: string): { label: string; tone: 'muted' | 'ok' | 'weak' } => {
  if (password.length === 0) return { label: '', tone: 'muted' };
  if (password.length < 10) return { label: 'Too short', tone: 'weak' };
  if (password.length < 14)
    return { label: 'Acceptable — a longer passphrase is stronger', tone: 'muted' };
  return { label: 'Good length', tone: 'ok' };
};

export default function RegisterPage(): React.JSX.Element {
  const router = useRouter();
  const { client } = useSession();
  const { state, start, fail, succeed } = useSubmitState();

  const [values, setValues] = useState<Record<FieldName, string>>({
    displayName: '',
    username: '',
    email: '',
    password: '',
  });
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const strength = useMemo(() => describePassword(values.password), [values.password]);

  const update = (field: FieldName, value: string): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
  };

  /** Moves focus to the first field the server or schema rejected. */
  const focusFirstError = (errors: Readonly<Record<string, string>>): void => {
    const order: readonly string[] = ['displayName', 'username', 'email', 'password'];
    const first = order.find((name) => errors[name] !== undefined);
    if (first === undefined || formRef.current === null) return;

    const element = formRef.current.querySelector<HTMLElement>(`[name="${first}"]`);
    element?.focus();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    start();

    const parsed = registerRequestSchema.safeParse(values);
    if (!parsed.success) {
      const fields = fieldsFromZod(parsed.error);
      fail({ fields });
      setTouched({ displayName: true, username: true, email: true, password: true });
      focusFirstError(fields);
      return;
    }

    try {
      await client.publicRequest<RegisteredResponse>('/api/v1/auth/register', {
        method: 'POST',
        body: parsed.data,
      });
      succeed();
      // The verification step needs the email; it is passed in the URL because
      // the account is not signed in yet, so there is no other place to keep it.
      router.push(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
    } catch (error) {
      if (isApiFailure(error)) {
        const mapped = fieldsFromApi(error);
        fail({
          fields: mapped.fields,
          form: mapped.form === null ? null : error.message,
        });
        setTouched({ displayName: true, username: true, email: true, password: true });
        focusFirstError(mapped.fields);
        return;
      }
      fail({ form: describeError(error) });
    }
  };

  return (
    <div className="flex flex-col gap-lg rounded-lg border border-border bg-surface p-lg shadow-md">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading">Create your account</h1>
        <p className="text-small text-muted">It takes less than a minute.</p>
      </header>

      {state.formError !== null ? <FormError>{state.formError}</FormError> : null}

      <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-md">
        {FIELDS.map((field) => (
          <div key={field.name} className="flex flex-col gap-1">
            <TextField
              label={field.label}
              htmlFor={field.name}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              required
              value={values[field.name]}
              onChange={(event) => update(field.name, event.target.value)}
              onBlur={() => setTouched((previous) => ({ ...previous, [field.name]: true }))}
              error={touched[field.name] === true ? state.fieldErrors[field.name] : undefined}
              {...(field.hint === undefined ? {} : { hint: field.hint })}
              {...(field.inputMode === undefined ? {} : { inputMode: field.inputMode })}
            />

            {field.name === 'password' && strength.label.length > 0 ? (
              <p
                className={
                  strength.tone === 'weak'
                    ? 'text-caption text-danger'
                    : strength.tone === 'ok'
                      ? 'text-caption text-success'
                      : 'text-caption text-muted'
                }
                // Not a live region: announcing every keystroke's assessment would
                // interrupt the user mid-typing.
              >
                {strength.label}
              </p>
            ) : null}
          </div>
        ))}

        <Button type="submit" size="lg" fullWidth loading={state.submitting}>
          {state.submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <p className="text-center text-small text-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

'use client';

/**
 * Form field primitives: `Field`, `Input`, `FormError`, `FormNotice`.
 *
 * Accessibility is structural here, not a checklist applied later:
 *
 *   * The label is a real `<label>` bound by `htmlFor`, never a placeholder.
 *     A placeholder disappears the moment the user types, so anyone who looks
 *     away has lost the question — and screen readers may skip it entirely.
 *   * `aria-describedby` links the hint and the error to the input, so the
 *     message is announced when the field receives focus rather than being
 *     visual decoration beside it.
 *   * `aria-invalid` is set, so assistive tech announces the field as erroneous.
 *   * The error is rendered in a container with `role="alert"` only when it
 *     appears, so it is announced once, not on every keystroke.
 *
 * The error is placed directly under the field rather than at the top of the
 * form: an error the user has to hunt for is an error they will not fix.
 */

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { CircleAlert, Info } from 'lucide-react';

import { cn } from '@/lib/cn';

export type FieldProps = {
  readonly label: string;
  readonly htmlFor: string;
  // `| undefined` is explicit on purpose: with exactOptionalPropertyTypes, `?:`
  // alone means "absent", and a form passing `error={maybeUndefined}` is rejected.
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  readonly children: ReactNode;
};

export const Field = ({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: FieldProps): React.JSX.Element => (
  <div className="flex flex-col gap-xs">
    <label htmlFor={htmlFor} className="text-small font-medium text-text">
      {label}
      {required === true ? (
        // Not an asterisk without explanation: the word is what a screen reader
        // reads, and "required" is unambiguous in every language.
        <span className="ml-1 text-danger" aria-hidden>
          *
        </span>
      ) : null}
      {required === true ? <span className="sr-only"> (required)</span> : null}
    </label>

    {children}

    {hint !== undefined && error === undefined ? (
      <p id={`${htmlFor}-hint`} className="text-caption text-muted">
        {hint}
      </p>
    ) : null}

    {error !== undefined ? (
      <p
        id={`${htmlFor}-error`}
        role="alert"
        className="flex items-start gap-1 text-caption text-danger"
      >
        <CircleAlert aria-hidden className="mt-[1px] size-3.5 shrink-0" />
        <span>{error}</span>
      </p>
    ) : null}
  </div>
);

export type InputProps = {
  readonly invalid?: boolean | undefined;
  readonly hint?: string | undefined;
} & InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, hint, id, ...rest },
  ref,
) {
  const describedBy =
    [hint !== undefined ? `${id ?? ''}-hint` : null, invalid === true ? `${id ?? ''}-error` : null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <input
      ref={ref}
      id={id}
      // 16px text: anything smaller makes iOS Safari zoom on focus, which shifts
      // the whole layout and loses the user's place.
      className={cn(
        'h-11 w-full rounded-md border bg-surface px-sm text-body text-text',
        'placeholder:text-muted/70',
        'transition-colors duration-fast ease-standard',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        'disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted',
        invalid === true ? 'border-danger' : 'border-border-strong/40',
        className,
      )}
      // HTML serialisation: an absent attribute is what a browser sees as "valid".
      // `aria-invalid="false"` is also valid ARIA, but omitting it keeps the DOM
      // honest for readers of the markup and for tests that assert on absence.
      aria-invalid={invalid === true ? true : undefined}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      {...rest}
    />
  );
});

/**
 * Wraps a field and injects the shared id/hint/error wiring, so a page cannot
 * forget one of the three attributes and silently break the announcement.
 */
export const TextField = forwardRef<
  HTMLInputElement,
  Omit<FieldProps, 'children'> & Omit<InputProps, 'id' | 'invalid'>
>(function TextField({ label, htmlFor, hint, error, required, ...input }, ref) {
  return (
    <Field
      label={label}
      htmlFor={htmlFor}
      required={required}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
    >
      <Input
        ref={ref}
        id={htmlFor}
        invalid={error !== undefined}
        {...(hint === undefined ? {} : { hint })}
        {...input}
      />
    </Field>
  );
});

/** Form-level error: something that happened to the request, not to one field. */
export const FormError = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div
    role="alert"
    className="flex items-start gap-xs rounded-md border border-danger/30 bg-danger-surface px-sm py-xs text-small text-danger"
  >
    <CircleAlert aria-hidden className="mt-[2px] size-4 shrink-0" />
    <div>{children}</div>
  </div>
);

export const FormNotice = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <div className="flex items-start gap-xs rounded-md border border-primary/30 bg-primary/5 px-sm py-xs text-small text-text">
    <Info aria-hidden className="mt-[2px] size-4 shrink-0 text-primary" />
    <div>{children}</div>
  </div>
);

/** Generates a stable id for a field when the caller does not own one. */
export const useFieldId = (name: string): string => {
  const generated = useId();
  return `${name}-${generated}`;
};

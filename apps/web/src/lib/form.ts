/**
 * Form state helpers.
 *
 * The rule this enforces: a form validates with the **server's** schema. Not a
 * copy of it, not a looser approximation — the same `zod` object the API runs.
 * A client-side check that is stricter than the server rejects valid input; one
 * that is looser shows the user a green tick before the API refuses. Both are
 * bugs, and both are impossible if there is only one schema.
 *
 * Validation timing is also deliberate:
 *
 *   * Never on the first keystroke — telling someone their email is invalid after
 *     the "a" of "ada@..." is noise, not help.
 *   * On blur, once the field has been left.
 *   * Always on submit, with focus moved to the first offending field so a
 *     keyboard user is not stranded at the bottom of a long form.
 */

import { useState } from 'react';
import type { z } from 'zod';

import type { ApiError, ApiFailure } from './api-client';
import { isApiFailure } from './api-client';

export type FieldErrors = Readonly<Record<string, string>>;

/** Collapses a ZodError into one message per field — the first, which is the primary one. */
export const fieldsFromZod = (error: z.ZodError): FieldErrors => {
  const errors: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '_form' : issue.path.join('.');
    // Keep the first issue per field: showing three stacked messages for one
    // input makes the user fix them one at a time and re-submit three times.
    errors[key] ??= issue.message;
  }

  return errors;
};

/** Maps an API failure onto field errors, falling back to a form-level message. */
export const fieldsFromApi = (
  failure: ApiFailure,
): { fields: FieldErrors; form: string | null } => {
  const fields: Record<string, string> = {};

  for (const issue of failure.issues) {
    const key = issue.path.length === 0 ? '_form' : issue.path;
    fields[key] ??= issue.message;
  }

  return {
    fields,
    form: Object.keys(fields).length === 0 ? failure.message : null,
  };
};

export type SubmitState = {
  readonly submitting: boolean;
  readonly formError: string | null;
  readonly fieldErrors: FieldErrors;
};

export const initialSubmitState: SubmitState = {
  submitting: false,
  formError: null,
  fieldErrors: {},
};

/** Human-readable message for any failure the client can produce. */
export const describeError = (error: unknown): string => {
  if (isApiFailure(error as ApiError)) return (error as ApiFailure).message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'Something went wrong. Please try again.';
};

/**
 * Validates one field in isolation, for the on-blur behaviour.
 *
 * The whole schema is applied and only this field's issues are kept, rather than
 * validating the field alone: a field's rules sometimes depend on its siblings
 * (a confirmation must match), and re-using the schema means there is still
 * exactly one definition of what is valid.
 *
 * Returns `undefined` when the field is valid, so a caller can pass the result
 * straight through as a prop.
 */
export const validateField = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  values: unknown,
  field: string,
): string | undefined => {
  const result = schema.safeParse(values);
  if (result.success) return undefined;

  const issue = result.error.issues.find((candidate) => candidate.path.join('.') === field);
  return issue?.message;
};

/**
 * Small reducer-free hook: one object of state, three transitions.
 *
 * Keeping submit state in a single value means a form cannot end up simultaneously
 * "submitting" and showing an error from the previous attempt, which is exactly
 * what happens with independent `useState` calls.
 */
export const useSubmitState = (): {
  state: SubmitState;
  start: () => void;
  fail: (next: { fields?: FieldErrors; form?: string | null }) => void;
  setFieldError: (field: string, message: string | undefined) => void;
  succeed: () => void;
} => {
  const [state, setState] = useState<SubmitState>(initialSubmitState);

  return {
    state,
    start: () => setState({ submitting: true, formError: null, fieldErrors: {} }),
    fail: (next) =>
      setState({
        submitting: false,
        formError: next.form ?? null,
        fieldErrors: next.fields ?? {},
      }),
    /**
     * Sets or clears one field's error, leaving the rest untouched. Used by
     * on-blur validation, which must not wipe a form-level message the server
     * returned for a different reason.
     */
    setFieldError: (field, message) =>
      setState((previous) => {
        const next = { ...previous.fieldErrors };
        if (message === undefined) {
          delete next[field];
        } else {
          next[field] = message;
        }
        return { ...previous, fieldErrors: next };
      }),
    succeed: () => setState(initialSubmitState),
  };
};

/**
 * DomainException — the only exception type the API deliberately throws.
 *
 * It carries a domain `AppError`, so the filter can map it to a status without
 * guessing, and it is cheap to construct (no stack capture) because denials are
 * expected control flow, not faults.
 */

import type { AppError } from '@socialhub/kernel';

export class DomainException extends Error {
  public readonly error: AppError;

  public constructor(error: AppError) {
    super(error.message);
    this.name = 'DomainException';
    this.error = error;
    // A denial is a decision, not a bug: dropping the captured stack keeps the
    // exception cheap to throw on hot paths.
    if ('captureStackTrace' in Error) {
      Error.captureStackTrace(this, DomainException);
    }
    delete (this as { stack?: string }).stack;
  }
}

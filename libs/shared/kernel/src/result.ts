/**
 * Result — explicit success/failure without exceptions for expected outcomes.
 *
 * Exceptions remain reserved for programmer error and unrecoverable faults;
 * anything callers must branch on is modelled in the type system instead.
 */

export type Success<T> = {
  readonly ok: true;
  readonly value: T;
};

export type Failure<E> = {
  readonly ok: false;
  readonly error: E;
};

export type Result<T, E> = Success<T> | Failure<E>;

export const ok = <T>(value: T): Success<T> => ({ ok: true, value });

export const fail = <E>(error: E): Failure<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Success<T> => result.ok;

export const isFail = <T, E>(result: Result<T, E>): result is Failure<E> => !result.ok;

/** Maps the success channel, leaving a failure untouched. */
export const mapResult = <T, U, E>(result: Result<T, E>, mapper: (value: T) => U): Result<U, E> =>
  result.ok ? ok(mapper(result.value)) : result;

/** Unwraps a success or throws, for call sites where the failure is impossible by construction. */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) {
    throw new Error(`Expected success result, received failure: ${String(result.error)}`);
  }
  return result.value;
};

import { type CurrencyCode, type Money, isCurrencyCode } from './money.js';
import type { Result } from './result.js';
import { fail, ok } from './result.js';

export type FxRate = {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Quote units per one base unit, scaled by 10^6 to stay integral. */
  readonly ratePpm: number;
};

export type FxError =
  | { readonly code: 'UNSUPPORTED_CURRENCY'; readonly currency: string }
  | { readonly code: 'RATE_UNAVAILABLE'; readonly base: CurrencyCode; readonly quote: CurrencyCode }
  | { readonly code: 'OVERFLOW' };

export const RATE_SCALE = 1_000_000;

/**
 * Converts money at an explicit rate, rounding half-up on the minor unit.
 * The rate must be supplied by the caller: this module never reads the network,
 * so conversion stays a pure function that the ledger can replay exactly.
 */
export const convert = (amount: Money, rate: FxRate): Result<Money, FxError> => {
  if (!isCurrencyCode(rate.quote))
    return fail({ code: 'UNSUPPORTED_CURRENCY', currency: rate.quote });
  if (amount.currency !== rate.base) {
    return fail({ code: 'RATE_UNAVAILABLE', base: rate.base, quote: amount.currency });
  }
  if (!Number.isInteger(rate.ratePpm) || rate.ratePpm <= 0) {
    return fail({ code: 'RATE_UNAVAILABLE', base: rate.base, quote: rate.quote });
  }
  const scaled = amount.minor * rate.ratePpm;
  if (!Number.isSafeInteger(scaled)) return fail({ code: 'OVERFLOW' });
  const converted = Math.round(scaled / RATE_SCALE);
  if (!Number.isSafeInteger(converted)) return fail({ code: 'OVERFLOW' });
  return ok({ currency: rate.quote, minor: converted });
};

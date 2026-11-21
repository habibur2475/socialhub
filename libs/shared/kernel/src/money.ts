/**
 * Money — exact, currency-aware monetary value.
 *
 * All amounts are stored and computed as integer minor units (paisa, cents) so
 * that no binary floating point value ever touches a balance. Only ISO 4217
 * currencies with a known exponent are accepted; the supported set is closed
 * on purpose so that arithmetic can never mix incompatible scales.
 */

import { type Result, fail, ok } from './result.js';

export const CURRENCIES = {
  BDT: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  AED: 2,
  SAR: 2,
  MYR: 2,
  JPY: 0,
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

const CURRENCY_CODES = Object.keys(CURRENCIES) as readonly CurrencyCode[];

export const isCurrencyCode = (value: string): value is CurrencyCode =>
  (CURRENCY_CODES as readonly string[]).includes(value);

export type Money = {
  readonly currency: CurrencyCode;
  /** Signed integer amount in the currency's minor unit. */
  readonly minor: number;
};

export type MoneyError =
  | { readonly code: 'UNSUPPORTED_CURRENCY'; readonly currency: string }
  | { readonly code: 'CURRENCY_MISMATCH'; readonly left: CurrencyCode; readonly right: CurrencyCode }
  | { readonly code: 'NON_INTEGER_MINOR_UNIT'; readonly minor: number }
  | { readonly code: 'AMOUNT_OUT_OF_RANGE' }
  | { readonly code: 'NEGATIVE_AMOUNT'; readonly minor: number }
  | { readonly code: 'DIVISION_BY_ZERO' };

/** Beyond ±(2^53-1) minor units integer arithmetic stops being exact. */
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export const money = (minor: number, currency: CurrencyCode): Result<Money, MoneyError> => {
  if (!Number.isInteger(minor)) return fail({ code: 'NON_INTEGER_MINOR_UNIT', minor });
  if (Math.abs(minor) > MAX_MINOR) return fail({ code: 'AMOUNT_OUT_OF_RANGE' });
  return ok({ currency, minor: minor === 0 ? 0 : minor });
};

export const zero = (currency: CurrencyCode): Money => ({ currency, minor: 0 });

export const add = (left: Money, right: Money): Result<Money, MoneyError> => {
  if (left.currency !== right.currency) {
    return fail({ code: 'CURRENCY_MISMATCH', left: left.currency, right: right.currency });
  }
  return money(left.minor + right.minor, left.currency);
};

export const subtract = (left: Money, right: Money): Result<Money, MoneyError> => {
  if (left.currency !== right.currency) {
    return fail({ code: 'CURRENCY_MISMATCH', left: left.currency, right: right.currency });
  }
  return money(left.minor - right.minor, left.currency);
};

/** Integer division by a positive integer quantity, truncating toward zero. */
export const divide = (amount: Money, divisor: number): Result<Money, MoneyError> => {
  if (!Number.isInteger(divisor) || divisor === 0) return fail({ code: 'DIVISION_BY_ZERO' });
  return money(Math.trunc(amount.minor / divisor), amount.currency);
};

/**
 * Splits `amount` into `parts` shares using the largest-remainder method so the
 * parts always sum back to the input exactly. Each part carries its own weight
 * in basis points (1/10000). Weights must be positive and must total 10,000.
 *
 * This is the primitive behind creator revenue splits and commission ladders:
 * the invariant `sum(result) === amount` is what keeps the platform ledger
 * balanced to the last minor unit.
 */
export const allocate = (
  amount: Money,
  weights: readonly number[],
): Result<readonly Money[], MoneyError> => {
  if (weights.length === 0) return ok([]);
  if (amount.minor < 0) return fail({ code: 'NEGATIVE_AMOUNT', minor: amount.minor });
  if (weights.some((weight) => !Number.isInteger(weight) || weight < 0)) {
    return fail({ code: 'NON_INTEGER_MINOR_UNIT', minor: amount.minor });
  }
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return fail({ code: 'DIVISION_BY_ZERO' });

  const exact = weights.map((weight) => (amount.minor * weight) / totalWeight);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = amount.minor - floors.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const shares = [...floors];
  for (const { index } of order) {
    if (remainder <= 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    remainder -= 1;
  }

  const allocated: Money[] = [];
  for (const share of shares) {
    const build = money(share, amount.currency);
    if (!build.ok) return build;
    allocated.push(build.value);
  }
  return ok(allocated);
};

export const isZero = (amount: Money): boolean => amount.minor === 0;

export const isPositive = (amount: Money): boolean => amount.minor > 0;

export const equals = (left: Money, right: Money): boolean =>
  left.currency === right.currency && left.minor === right.minor;

/** Human-readable decimal string using the currency exponent, e.g. 123456 -> "1234.56". */
export const format = (amount: Money): string => {
  const exponent = CURRENCIES[amount.currency];
  if (exponent === 0) return `${amount.minor}`;
  const negative = amount.minor < 0;
  const digits = Math.abs(amount.minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
};

/**
 * Parses a user- or API-supplied decimal string ("1234.56", "-0.05") into the
 * exact minor-unit integer. Rejects anything that would require rounding.
 */
export const parse = (input: string, currency: CurrencyCode): Result<Money, MoneyError> => {
  const exponent = CURRENCIES[currency];
  const pattern = exponent === 0 ? /^-?(0|[1-9]\d*)$/ : new RegExp(`^-?(0|[1-9]\\d*)(\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(input)) return fail({ code: 'NON_INTEGER_MINOR_UNIT', minor: Number.NaN });
  const negative = input.startsWith('-');
  const [whole = '0', fraction = ''] = input.replace('-', '').split('.');
  const padded = fraction.padEnd(exponent, '0');
  const minor = Number(`${whole}${padded}`);
  return money(negative ? -minor : minor, currency);
};

/**
 * দৈনন্দিন আয়-ব্যয়ের হিসাব — the daily income and expense ledger.
 *
 * The whole file is integer minor units (paisa), never floats. `0.1 + 0.2` is the bug that
 * makes a household ledger disagree with the cash in the envelope by one taka, and a
 * ledger that does not reconcile is a ledger nobody keeps.
 *
 * Two decisions worth stating:
 *
 *   * **An entry's amount is stored positive and its direction is a separate field.** A
 *     refund is an income entry, not a negative expense — otherwise every total is a
 *     question about which sign convention a particular row used.
 *   * **A day is a `YYYY-MM-DD` string**, so "this week" and "this month" are calendar
 *     questions that work in Dhaka and in UTC alike.
 */

import { type Result, fail, ok } from '../../result.js';
import { type CalendarDate, daysBetween, dayNumber } from '../calendar.js';
import { parse, type Money } from '../../money.js';

export type EntryDirection = 'INCOME' | 'EXPENSE';

export const ENTRY_DIRECTIONS: readonly EntryDirection[] = ['INCOME', 'EXPENSE'];

export type ExpenseCategory =
  | 'FOOD'
  | 'TRANSPORT'
  | 'RENT'
  | 'UTILITIES'
  | 'HEALTH'
  | 'EDUCATION'
  | 'FAMILY'
  | 'OTHER';

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'FOOD',
  'TRANSPORT',
  'RENT',
  'UTILITIES',
  'HEALTH',
  'EDUCATION',
  'FAMILY',
  'OTHER',
];

/** How each category is labelled in the UI — Bengali first, because the tool is. */
export const CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  FOOD: 'খাবার',
  TRANSPORT: 'যাতায়াত',
  RENT: 'বাসা ভাড়া',
  UTILITIES: 'বিদ্যুৎ, পানি, গ্যাস',
  HEALTH: 'চিকিৎসা',
  EDUCATION: 'শিক্ষা',
  FAMILY: 'পরিবার',
  OTHER: 'অন্যান্য',
};

export const DIRECTION_LABELS: Readonly<Record<EntryDirection, string>> = {
  INCOME: 'আয়',
  EXPENSE: 'ব্যয়',
};

export type LedgerEntry = {
  readonly id: string;
  readonly date: CalendarDate;
  readonly direction: EntryDirection;
  /** Always a positive integer count of paisa. */
  readonly minor: number;
  readonly category: ExpenseCategory;
  /** Free text, e.g. "বাজার" or "রিকশা". */
  readonly note: string;
};

export type LedgerError =
  | { readonly code: 'AMOUNT_NOT_POSITIVE' }
  | { readonly code: 'AMOUNT_NOT_AN_INTEGER'; readonly minor: number }
  | { readonly code: 'UNKNOWN_CATEGORY'; readonly category: string };

/**
 * Validates one entry.
 *
 * Negative and zero amounts are both refused: a zero entry is not an expense, and a
 * negative one is a refund that belongs in the opposite direction column. Accepting either
 * would make the category totals depend on a sign convention.
 */
export const checkLedgerEntry = (entry: {
  readonly direction: EntryDirection;
  readonly minor: number;
  readonly category: string;
}): LedgerError | null => {
  if (!Number.isInteger(entry.minor)) return { code: 'AMOUNT_NOT_AN_INTEGER', minor: entry.minor };
  if (entry.minor <= 0) return { code: 'AMOUNT_NOT_POSITIVE' };
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(entry.category)) {
    return { code: 'UNKNOWN_CATEGORY', category: entry.category };
  }
  return null;
};

/** "১২৫০.৫০" → 125050 paisa, refusing anything that would need rounding. */
export const amountFromInput = (input: string): Result<Money, { readonly code: 'BAD_AMOUNT' }> => {
  const cleaned = input
    .replace(/[,\s৳$]/gu, '')
    .replace(/[০-৯]/gu, (digit) => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)));
  if (cleaned === '') return fail({ code: 'BAD_AMOUNT' });
  const parsed = parse(cleaned, 'BDT');
  return parsed.ok ? ok(parsed.value) : fail({ code: 'BAD_AMOUNT' });
};

export type Bucket = {
  readonly category: ExpenseCategory;
  readonly label: string;
  readonly minor: number;
  /** Whole percent of all spending; `0` when nothing was spent. */
  readonly percent: number;
};

export type LedgerSummary = {
  readonly buckets: readonly Bucket[];
  readonly income: number;
  readonly spent: number;
  /** `income - spent`; negative is an overspend, which is a fact rather than an error. */
  readonly remaining: number;
  readonly overspentBy: number;
  readonly spentPercent: number | null;
  readonly largest: Bucket | null;
  readonly entryCount: number;
  /** The average daily spend across the days the ledger covers, or `null` with no days. */
  readonly averageDailySpend: number | null;
};

const DAY_MS = 86_400_000;

/**
 * Totals over a set of entries.
 *
 * `spanDays` is passed rather than derived: the ledger knows which month is on screen, and
 * a summary that inferred its span from the entries would report a 3-day average for a
 * month in which someone only spent on three days.
 */
export const summariseLedger = (
  entries: readonly LedgerEntry[],
  options: { readonly spanDays?: number } = {},
): LedgerSummary => {
  const buckets = new Map<ExpenseCategory, number>(
    EXPENSE_CATEGORIES.map((category) => [category, 0]),
  );

  let income = 0;
  let spent = 0;

  for (const entry of entries) {
    const amount = Math.abs(Math.trunc(entry.minor));

    if (entry.direction === 'INCOME') {
      income += amount;
      continue;
    }

    spent += amount;
    // An entry carrying a category the list does not know is counted under OTHER rather
    // than dropped: a total that disagrees with the rows above it is worse than a lump.
    const key = buckets.has(entry.category) ? entry.category : 'OTHER';
    buckets.set(key, (buckets.get(key) ?? 0) + amount);
  }

  const bucketList: Bucket[] = EXPENSE_CATEGORIES.map((category) => {
    const minor = buckets.get(category) ?? 0;
    return {
      category,
      label: CATEGORY_LABELS[category],
      minor,
      percent: spent === 0 ? 0 : Math.round((minor / spent) * 100),
    };
  });

  let largest: Bucket | null = null;
  for (const bucket of bucketList) {
    if (bucket.minor > 0 && (largest === null || bucket.minor > largest.minor)) largest = bucket;
  }

  const spanDays = options.spanDays ?? 0;

  return {
    buckets: bucketList,
    income,
    spent,
    remaining: income - spent,
    overspentBy: Math.max(0, spent - income),
    spentPercent: income === 0 ? null : Math.round((spent / income) * 100),
    largest,
    entryCount: entries.length,
    averageDailySpend: spanDays > 0 ? Math.round(spent / spanDays) : null,
  };
};

/** The first and last day of a month, as calendar dates. */
export const monthRange = (
  year: number,
  month: number,
): { from: CalendarDate; to: CalendarDate } => {
  const from = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from,
    to: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
};

/** Inclusive day count between two calendar dates; `0` when the range is inverted. */
export const spanBetween = (from: CalendarDate, to: CalendarDate): number =>
  Math.max(0, daysBetween(from, to) + 1);

/**
 * Splits the month so far into daily totals, for a bar strip.
 *
 * Days with no entries are present with `0`: a chart that skips empty days draws a
 * continuous line through a week of spending that did not happen.
 */
export const dailyTotals = (
  entries: readonly LedgerEntry[],
  from: CalendarDate,
  to: CalendarDate,
): readonly { readonly date: CalendarDate; readonly spent: number; readonly income: number }[] => {
  const days = spanBetween(from, to);
  if (days === 0) return [];

  const totals = new Map<string, { spent: number; income: number }>();
  for (const entry of entries) {
    if (dayNumber(entry.date) < dayNumber(from) || dayNumber(entry.date) > dayNumber(to)) continue;
    const current = totals.get(entry.date) ?? { spent: 0, income: 0 };
    const amount = Math.abs(Math.trunc(entry.minor));
    totals.set(entry.date, {
      spent: current.spent + (entry.direction === 'EXPENSE' ? amount : 0),
      income: current.income + (entry.direction === 'INCOME' ? amount : 0),
    });
  }

  const result: { date: CalendarDate; spent: number; income: number }[] = [];
  for (let index = 0; index < days; index += 1) {
    const stamp = new Date(dayNumber(from) * DAY_MS + index * DAY_MS);
    const date = stamp.toISOString().slice(0, 10);
    const total = totals.get(date) ?? { spent: 0, income: 0 };
    result.push({ date, spent: total.spent, income: total.income });
  }

  return result;
};

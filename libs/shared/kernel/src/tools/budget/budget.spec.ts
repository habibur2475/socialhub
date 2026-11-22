import { describe, expect, it } from 'vitest';

import {
  amountFromInput,
  checkLedgerEntry,
  dailyTotals,
  monthRange,
  spanBetween,
  summariseLedger,
} from './budget.js';

const entry = (
  overrides: Partial<
    Parameters<typeof checkLedgerEntry>[0] & { id: string; date: string; note: string }
  > = {},
) => ({
  id: overrides.id ?? 'e1',
  date: overrides.date ?? '2026-11-05',
  direction: overrides.direction ?? ('EXPENSE' as const),
  minor: overrides.minor ?? 10_000,
  category: (overrides.category ?? 'FOOD') as never,
  note: overrides.note ?? '',
});

describe('ledger entries', () => {
  it('refuses a zero or negative amount', () => {
    expect(checkLedgerEntry({ direction: 'EXPENSE', minor: 0, category: 'FOOD' })).toEqual({
      code: 'AMOUNT_NOT_POSITIVE',
    });
    expect(checkLedgerEntry({ direction: 'INCOME', minor: -500, category: 'FOOD' })).toEqual({
      code: 'AMOUNT_NOT_POSITIVE',
    });
  });

  it('refuses a fractional minor unit and an unknown category', () => {
    expect(checkLedgerEntry({ direction: 'EXPENSE', minor: 10.5, category: 'FOOD' })).toEqual({
      code: 'AMOUNT_NOT_AN_INTEGER',
      minor: 10.5,
    });
    expect(checkLedgerEntry({ direction: 'EXPENSE', minor: 100, category: 'PETS' })).toEqual({
      code: 'UNKNOWN_CATEGORY',
      category: 'PETS',
    });
  });

  it('accepts a real entry', () => {
    expect(checkLedgerEntry({ direction: 'EXPENSE', minor: 12_050, category: 'FOOD' })).toBeNull();
  });

  it('parses an amount pasted with a currency sign, spaces or Bengali digits', () => {
    expect(amountFromInput('৳ 1,250.50')).toEqual({
      ok: true,
      value: { currency: 'BDT', minor: 125_050 },
    });
    expect(amountFromInput('১২৫০.৫০')).toEqual({
      ok: true,
      value: { currency: 'BDT', minor: 125_050 },
    });
    expect(amountFromInput('12.345')).toEqual({ ok: false, error: { code: 'BAD_AMOUNT' } });
    expect(amountFromInput('')).toEqual({ ok: false, error: { code: 'BAD_AMOUNT' } });
  });
});

describe('summariseLedger', () => {
  const entries = [
    entry({ id: '1', minor: 12_000, category: 'FOOD' }),
    entry({ id: '2', minor: 3_500, category: 'FOOD' }),
    entry({ id: '3', minor: 2_000, category: 'TRANSPORT' }),
    entry({ id: '4', minor: 25_000, category: 'RENT' }),
    entry({ id: '5', direction: 'INCOME', minor: 60_000, category: 'OTHER' }),
  ];

  it('totals income and spending separately, zero-filling every category', () => {
    const summary = summariseLedger(entries);
    expect(summary.income).toBe(60_000);
    expect(summary.spent).toBe(42_500);
    expect(summary.buckets.map((bucket) => bucket.category)).toHaveLength(8);
    expect(summary.buckets.find((bucket) => bucket.category === 'FOOD')?.minor).toBe(15_500);
    expect(summary.buckets.find((bucket) => bucket.category === 'HEALTH')?.minor).toBe(0);
  });

  it('reports what is left, the largest category and the share', () => {
    const summary = summariseLedger(entries, { spanDays: 30 });
    expect(summary.remaining).toBe(17_500);
    expect(summary.largest).toMatchObject({ category: 'RENT', minor: 25_000 });
    expect(summary.spentPercent).toBe(71);
    expect(summary.averageDailySpend).toBe(1417);
    expect(summary.buckets.find((bucket) => bucket.category === 'RENT')?.percent).toBe(59);
  });

  it('reports an overspend as a negative remainder, not an error', () => {
    const summary = summariseLedger(entries.filter((item) => item.direction === 'EXPENSE'));
    expect(summary.remaining).toBe(-42_500);
    expect(summary.overspentBy).toBe(42_500);
    expect(summary.spentPercent).toBeNull();
  });

  it('gives every category a Bengali label', () => {
    expect(summariseLedger([]).buckets.find((bucket) => bucket.category === 'FOOD')?.label).toBe(
      'খাবার',
    );
  });
});

describe('calendar helpers', () => {
  it('knows the first and last day of a month, leap year included', () => {
    expect(monthRange(2026, 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('counts days inclusively', () => {
    expect(spanBetween('2026-11-01', '2026-11-30')).toBe(30);
    expect(spanBetween('2026-11-30', '2026-11-01')).toBe(0);
  });

  it('fills the empty days in a strip instead of skipping them', () => {
    const totals = dailyTotals(
      [entry({ id: '1', date: '2026-11-02', minor: 5_000 })],
      '2026-11-01',
      '2026-11-03',
    );
    expect(totals).toEqual([
      { date: '2026-11-01', spent: 0, income: 0 },
      { date: '2026-11-02', spent: 5_000, income: 0 },
      { date: '2026-11-03', spent: 0, income: 0 },
    ]);
  });

  it('ignores entries outside the strip', () => {
    const totals = dailyTotals(
      [entry({ id: '1', date: '2026-12-02' })],
      '2026-11-01',
      '2026-11-02',
    );
    expect(totals.reduce((total, day) => total + day.spent, 0)).toBe(0);
  });
});

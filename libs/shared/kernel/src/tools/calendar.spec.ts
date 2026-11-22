import { describe, expect, it } from 'vitest';

import {
  addDays,
  daysBetween,
  daysInMonth,
  isLeapYear,
  parseCalendarDate,
  todayIn,
} from './calendar.js';

describe('calendar', () => {
  it('knows leap years, including the century rule', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('counts month lengths, and refuses a month outside 1–12', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2026, 13)).toBe(0);
  });

  it('separates malformed from impossible dates', () => {
    expect(parseCalendarDate('2026-2-3')).toEqual({
      ok: false,
      error: { code: 'MALFORMED_DATE', value: '2026-2-3' },
    });
    expect(parseCalendarDate('2025-02-30')).toEqual({
      ok: false,
      error: { code: 'IMPOSSIBLE_DATE', value: '2025-02-30' },
    });
    expect(parseCalendarDate('2024-02-29')).toEqual({ ok: true, value: '2024-02-29' });
  });

  it('adds days across months, leap days and years', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('measures a signed distance', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-05-02', '2026-05-01')).toBe(-1);
  });

  it('round-trips a whole leap year one day at a time', () => {
    let date = '2024-01-01';
    for (let index = 0; index < 366; index += 1) date = addDays(date, 1);
    expect(date).toBe('2025-01-01');
  });

  it('reads the local day of an instant, not its UTC day', () => {
    // 00:30 local on the 22nd is still the 21st in UTC for Dhaka; the local day wins.
    const local = new Date(2026, 10, 22, 0, 30);
    expect(todayIn(local)).toBe('2026-11-22');
  });
});

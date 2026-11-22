import { describe, expect, it } from 'vitest';

import { ageOn, celebrationIn, checkBirthDate } from './age.js';

describe('ageOn', () => {
  it('counts completed years, months and days', () => {
    const age = ageOn('1995-06-15', '2026-11-21');
    expect(age).toMatchObject({
      years: 31,
      months: 5,
      days: 6,
      totalYears: 31,
      daysToNextBirthday: 206,
    });
  });

  it('is exact on the birthday itself', () => {
    expect(ageOn('1990-11-21', '2026-11-21')).toMatchObject({
      years: 36,
      months: 0,
      days: 0,
      daysToNextBirthday: 0,
      turning: 36,
    });
  });

  it('gives a 29 February birthday a 1 March celebration in a common year', () => {
    expect(celebrationIn('2000-02-29', 2025)).toBe('2025-03-01');
    expect(celebrationIn('2000-02-29', 2028)).toBe('2028-02-29');
    expect(ageOn('2000-02-29', '2025-03-01')).toMatchObject({
      totalYears: 25,
      daysToNextBirthday: 0,
    });
  });

  it('borrows days from the previous month when needed', () => {
    expect(ageOn('2025-12-15', '2026-01-31')).toMatchObject({ months: 1, days: 16 });
  });

  it('reports the totals a form asks for', () => {
    const age = ageOn('2000-01-01', '2026-01-01');
    expect(age.totalMonths).toBe(312);
    expect(age.totalDays).toBe(9497);
    expect(age.totalWeeks).toBe(1356);
  });

  it('is never negative for a birth date in the future', () => {
    expect(ageOn('2030-01-01', '2026-11-21')).toMatchObject({ totalYears: 0, totalDays: 0 });
  });

  it('tells you which weekday you were born on', () => {
    // 1990-11-21 was a Wednesday.
    expect(ageOn('1990-11-21', '2026-11-21').weekdayOfBirth).toBe(3);
  });
});

describe('checkBirthDate', () => {
  it('refuses a future day and an implausible one', () => {
    expect(checkBirthDate('2026-12-01', '2026-11-21')).toEqual({ code: 'BIRTH_DATE_IN_FUTURE' });
    expect(checkBirthDate('1026-01-01', '2026-11-21')).toEqual({ code: 'AGE_IMPLAUSIBLE' });
    expect(checkBirthDate('1990-11-21', '2026-11-21')).toBeNull();
  });
});

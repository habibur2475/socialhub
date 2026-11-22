/**
 * Age calculator.
 *
 * People do not ask "how many milliseconds"; they ask three different questions, and the
 * tool answers all of them rather than silently picking one:
 *
 *   * completed years, months and days — the answer to "how old am I"
 *   * the next birthday and how many sleeps it is away
 *   * the total in days, weeks and months, for a form that wants a number
 *
 * All of it is calendar arithmetic over day numbers, so 29 February works and no birthday
 * shifts by a timezone.
 */

import {
  type CalendarDate,
  civilOf,
  daysBetween,
  daysInMonth,
  dayNumber,
  fromCivil,
  isLeapYear,
} from '../calendar.js';

export type Age = {
  readonly years: number;
  readonly months: number;
  readonly days: number;
  /** Completed years — what a form asking "how old are you" wants. */
  readonly totalYears: number;
  readonly totalMonths: number;
  readonly totalDays: number;
  readonly totalWeeks: number;
  /** Days until the next birthday; `0` on the birthday itself. */
  readonly daysToNextBirthday: number;
  readonly nextBirthday: CalendarDate;
  /** Which birthday the next one is — "turning 32". */
  readonly turning: number;
  readonly weekdayOfBirth: number;
};

/**
 * The day a birthday is celebrated in a given year.
 *
 * A 29 February birthday falls on 1 March in a common year: the legal convention in most
 * countries, and the only rule that does not make the birthday appear to move backwards
 * into February.
 */
export const celebrationIn = (birthDate: CalendarDate, year: number): CalendarDate => {
  const { month, day } = civilOf(birthDate);
  if (month === 2 && day === 29 && !isLeapYear(year)) return `${year}-03-01`;
  return fromCivil(year, month, Math.min(day, daysInMonth(year, month)));
};

/**
 * Age on a given day, in the way people count it.
 *
 * Borrowing is done from the *previous* month of `onDate`, not from the birth month: the
 * question is how many whole months have elapsed, and a month is as long as it was when it
 * passed.
 */
export const ageOn = (birthDate: CalendarDate, onDate: CalendarDate): Age => {
  const birth = civilOf(birthDate);
  const on = civilOf(onDate);

  let years = on.year - birth.year;
  let months = on.month - birth.month;
  let days = on.day - birth.day;

  if (days < 0) {
    months -= 1;
    const previousMonth = on.month === 1 ? 12 : on.month - 1;
    const previousYear = on.month === 1 ? on.year - 1 : on.year;
    days += daysInMonth(previousYear, previousMonth);
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const totalYears = Math.max(0, years);
  const totalDays = Math.max(0, daysBetween(birthDate, onDate));

  const thisYear = celebrationIn(birthDate, on.year);
  const nextBirthday =
    dayNumber(thisYear) < dayNumber(onDate) ? celebrationIn(birthDate, on.year + 1) : thisYear;

  return {
    years: totalYears,
    months: Math.max(0, months),
    days: Math.max(0, days),
    totalYears,
    totalMonths: totalYears * 12 + Math.max(0, months),
    totalDays,
    totalWeeks: Math.floor(totalDays / 7),
    daysToNextBirthday: Math.max(0, daysBetween(onDate, nextBirthday)),
    nextBirthday,
    turning: civilOf(nextBirthday).year - birth.year,
    // 0 = Sunday. The day you were born is the one fact an age calculator can give for free.
    weekdayOfBirth: ((dayNumber(birthDate) % 7) + 11) % 7,
  };
};

export type AgeRefusal =
  | { readonly code: 'BIRTH_DATE_IN_FUTURE' }
  | { readonly code: 'AGE_IMPLAUSIBLE' };

/**
 * Refuses the two inputs that are not a birth date: a future day, and a date more than 130
 * years ago. The second is not pedantry — it catches a mistyped year (1026 instead of 2026)
 * that would otherwise produce a confident "1000 years old".
 */
export const checkBirthDate = (
  birthDate: CalendarDate,
  onDate: CalendarDate,
): AgeRefusal | null => {
  const difference = daysBetween(birthDate, onDate);
  if (difference < 0) return { code: 'BIRTH_DATE_IN_FUTURE' };
  if (difference > 130 * 365 + 32) return { code: 'AGE_IMPLAUSIBLE' };
  return null;
};

export const AGE_MAX_YEARS = 130;

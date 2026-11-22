/**
 * Calendar arithmetic for the tools.
 *
 * The rule this file exists to enforce: **a calendar date is a `YYYY-MM-DD` string, not a
 * `Date`.** A `Date` is an instant in UTC; "21 November" is a day on a wall calendar. Every
 * time the two are converted through a timezone, somebody's birthday moves by a day — which
 * is why an age calculator built on `new Date(birth)` is wrong for half the world for part
 * of every day.
 *
 * The conversions here are Howard Hinnant's `days_from_civil` / `civil_from_days`, which
 * shift the year to start in March so that the leap day is the last day of the year and
 * every month-length special case disappears from the arithmetic.
 */

import { type Result, fail, ok } from '../result.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export type CalendarDate = string;

export type DateError =
  | { readonly code: 'MALFORMED_DATE'; readonly value: string }
  | { readonly code: 'IMPOSSIBLE_DATE'; readonly value: string };

const daysFromCivil = (year: number, month: number, day: number): number => {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const monthIndex = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
};

const civilFromDays = (days: number): { year: number; month: number; day: number } => {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export const civilOf = (date: CalendarDate): { year: number; month: number; day: number } => {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return { year, month, day };
};

export const fromCivil = (year: number, month: number, day: number): CalendarDate =>
  `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;

export const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export const daysInMonth = (year: number, month: number): number => {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
};

/**
 * Validates a calendar date.
 *
 * Malformed (`2026-2-3`) and impossible (`2025-02-30`) stay separate errors, because they
 * are different mistakes: a formatting bug in a client versus a person choosing a day that
 * does not exist.
 */
export const parseCalendarDate = (value: string): Result<CalendarDate, DateError> => {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) return fail({ code: 'MALFORMED_DATE', value });

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return fail({ code: 'IMPOSSIBLE_DATE', value });
  }

  return ok(fromCivil(year, month, day));
};

/** The day number of a validated date — the unit every interval below is measured in. */
export const dayNumber = (date: CalendarDate): number => {
  const { year, month, day } = civilOf(date);
  return daysFromCivil(year, month, day);
};

export const addDays = (date: CalendarDate, days: number): CalendarDate => {
  const { year, month, day } = civilFromDays(dayNumber(date) + Math.trunc(days));
  return fromCivil(year, month, day);
};

export const daysBetween = (from: CalendarDate, to: CalendarDate): number =>
  dayNumber(to) - dayNumber(from);

/** The local calendar day of an instant — the caller supplies "now", so this stays pure. */
export const todayIn = (now: Date): CalendarDate =>
  fromCivil(now.getFullYear(), now.getMonth() + 1, now.getDate());

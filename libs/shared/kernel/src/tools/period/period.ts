/**
 * মেয়েদের পিরিয়ড ম্যানেজমেন্ট — period tracking.
 *
 * This is the most sensitive data in the whole product, so the design is deliberately
 * boring and deliberately local:
 *
 *   * **Nothing here talks to a server.** The tracker keeps its log in the browser's own
 *     storage on the device. There is no account, no sync, no "share with a partner"
 *     feature, and therefore no breach that can expose it. The privacy of the tool is a
 *     property of its architecture, not a promise in a policy.
 *   * **A prediction is a window, never a verdict.** The app says "most likely between X
 *     and Y", not "you are fertile today". A cycle is not a metronome, and a tool that
 *     speaks with false precision about fertility is a tool that can cause harm.
 *   * **The arithmetic is explicit.** Gaps between logged starts, clamped to a plausible
 *     range; a mistyped date is dropped rather than allowed to shift every prediction.
 *
 * The ovulation estimate is the standard luteal-phase model: ovulation is 14 days before
 * the *next* period, and the fertile window is the six days ending on that day. It is
 * anchored to the end of the cycle on purpose — that is the part people get wrong.
 */

import { type Result, fail, ok } from '../../result.js';
import {
  type CalendarDate,
  addDays,
  daysBetween,
  dayNumber,
  daysInMonth,
  parseCalendarDate,
} from '../calendar.js';

export type FlowLevel = 'SPOTTING' | 'LIGHT' | 'MEDIUM' | 'HEAVY';

export const FLOW_LEVELS: readonly FlowLevel[] = ['SPOTTING', 'LIGHT', 'MEDIUM', 'HEAVY'];

export const FLOW_LABELS: Readonly<Record<FlowLevel, string>> = {
  SPOTTING: 'স্পটিং',
  LIGHT: 'হালকা',
  MEDIUM: 'মাঝারি',
  HEAVY: 'বেশি',
};

export type Symptom =
  | 'CRAMPS'
  | 'HEADACHE'
  | 'BACK_PAIN'
  | 'BLOATING'
  | 'MOOD'
  | 'FATIGUE'
  | 'ACNE'
  | 'NAUSEA';

export const SYMPTOMS: readonly Symptom[] = [
  'CRAMPS',
  'HEADACHE',
  'BACK_PAIN',
  'BLOATING',
  'MOOD',
  'FATIGUE',
  'ACNE',
  'NAUSEA',
];

export const SYMPTOM_LABELS: Readonly<Record<Symptom, string>> = {
  CRAMPS: 'পেট ব্যথা',
  HEADACHE: 'মাথাব্যথা',
  BACK_PAIN: 'কোমর ব্যথা',
  BLOATING: 'পেট ফোলা',
  MOOD: 'মুড পরিবর্তন',
  FATIGUE: 'ক্লান্তি',
  ACNE: 'ব্রণ',
  NAUSEA: 'বমি বমি ভাব',
};

export type PeriodDay = {
  readonly date: CalendarDate;
  readonly flow: FlowLevel;
  readonly symptoms: readonly Symptom[];
};

export type PeriodRefusal =
  | { readonly code: 'MALFORMED_DATE'; readonly value: string }
  | { readonly code: 'IMPOSSIBLE_DATE'; readonly value: string }
  | { readonly code: 'FUTURE_DAY' }
  | { readonly code: 'UNKNOWN_FLOW' }
  | { readonly code: 'TOO_FAR_IN_PAST' };

/** The log starts somewhere: two years is more history than a prediction needs. */
export const HISTORY_DAYS = 730;

export const validatePeriodDay = (
  day: PeriodDay,
  onDate: CalendarDate,
): Result<PeriodDay, PeriodRefusal> => {
  const parsed = parseCalendarDate(day.date);
  if (!parsed.ok) return parsed;
  if (dayNumber(parsed.value) > dayNumber(onDate)) return fail({ code: 'FUTURE_DAY' });
  if (daysBetween(parsed.value, onDate) > HISTORY_DAYS) return fail({ code: 'TOO_FAR_IN_PAST' });
  if (!FLOW_LEVELS.includes(day.flow)) return fail({ code: 'UNKNOWN_FLOW' });

  // Symptoms are de-duplicated and kept in the declared order, so two representations of
  // the same day render identically.
  const symptoms = SYMPTOMS.filter((symptom) => day.symptoms.includes(symptom));
  return ok({ date: parsed.value, flow: day.flow, symptoms });
};

/** The first day of each bleed, most recent first. A bleed is a contiguous run of days. */
export const bleedStarts = (days: readonly PeriodDay[]): readonly CalendarDate[] => {
  const dates = [...new Set(days.map((day) => day.date))].sort();
  const starts: CalendarDate[] = [];

  for (const date of dates) {
    const previous = addDays(date, -1);
    if (!dates.includes(previous)) starts.push(date);
  }

  return starts.reverse();
};

export const DEFAULT_CYCLE_LENGTH = 28;
export const MIN_CYCLE_LENGTH = 15;
export const MAX_CYCLE_LENGTH = 60;
/** How many completed cycles the average is taken over; older ones are history. */
export const CYCLE_AVERAGE_WINDOW = 6;

/**
 * The average cycle length from the starts, most recent first.
 *
 * Gaps that are impossible (`0`) or implausible (beyond `MAX_CYCLE_LENGTH`) are dropped
 * rather than clamped: one mistyped date should not shift every prediction, and calling a
 * 300-day gap a 60-day cycle would be a confident lie.
 */
export const averageCycleLength = (starts: readonly CalendarDate[]): number => {
  const ordered = [...starts].sort((left, right) => dayNumber(right) - dayNumber(left));
  const gaps: number[] = [];

  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const newer = ordered[index];
    const older = ordered[index + 1];
    if (newer === undefined || older === undefined) continue;
    const gap = daysBetween(older, newer);
    if (gap >= MIN_CYCLE_LENGTH && gap <= MAX_CYCLE_LENGTH) gaps.push(gap);
    if (gaps.length === CYCLE_AVERAGE_WINDOW) break;
  }

  if (gaps.length === 0) return DEFAULT_CYCLE_LENGTH;
  return Math.round(gaps.reduce((total, gap) => total + gap, 0) / gaps.length);
};

export const cycleRange = (
  starts: readonly CalendarDate[],
): { readonly shortest: number; readonly longest: number } | null => {
  const ordered = [...starts].sort((left, right) => dayNumber(left) - dayNumber(right));
  const gaps: number[] = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const newer = ordered[index];
    const older = ordered[index - 1];
    if (newer === undefined || older === undefined) continue;
    const gap = daysBetween(older, newer);
    if (gap >= MIN_CYCLE_LENGTH && gap <= MAX_CYCLE_LENGTH) gaps.push(gap);
  }

  if (gaps.length === 0) return null;
  return { shortest: Math.min(...gaps), longest: Math.max(...gaps) };
};

/** Typical bleed length from the logged runs, clamped to something sensible. */
export const averagePeriodLength = (days: readonly PeriodDay[]): number => {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const lengths: number[] = [];

  for (const start of bleedStarts(days)) {
    let length = 1;
    while (byDate.has(addDays(start, length))) length += 1;
    if (length >= 1 && length <= 14) lengths.push(length);
  }

  if (lengths.length === 0) return 5;
  return Math.max(
    1,
    Math.round(lengths.reduce((total, value) => total + value, 0) / lengths.length),
  );
};

export type CyclePrediction = {
  /** The average the prediction used, so the screen can say where the number came from. */
  readonly cycleLength: number;
  readonly periodLength: number;
  readonly nextStart: CalendarDate;
  /** The days the next period is most likely to begin within. */
  readonly windowStart: CalendarDate;
  readonly windowEnd: CalendarDate;
  readonly ovulation: CalendarDate;
  /** The six most fertile days, ending on ovulation. */
  readonly fertileStart: CalendarDate;
  readonly fertileEnd: CalendarDate;
  readonly daysUntilNext: number;
  /** 1-based day of the current cycle, or `null` before any period has been logged. */
  readonly cycleDay: number | null;
  readonly lastStart: CalendarDate | null;
};

/**
 * Predicts the next cycle from the logged days.
 *
 * If the predicted date has already passed — someone travelled, or did not log — the
 * projection rolls forward rather than showing a date in the past. It is capped at two
 * years of rolling so a stale log cannot produce a date in 2040.
 */
export const predictCycle = (
  days: readonly PeriodDay[],
  onDate: CalendarDate,
): CyclePrediction | null => {
  const starts = bleedStarts(days);
  const lastStart = starts[0];
  if (lastStart === undefined) return null;

  const cycleLength = averageCycleLength(starts);
  const periodLength = averagePeriodLength(days);

  let nextStart = addDays(lastStart, cycleLength);
  let guard = 0;
  while (dayNumber(nextStart) < dayNumber(onDate) && guard < 24) {
    nextStart = addDays(nextStart, cycleLength);
    guard += 1;
  }

  // Ovulation is anchored to the *next* period, not this one: 14 days before it.
  const ovulation = addDays(nextStart, -14);

  return {
    cycleLength,
    periodLength,
    nextStart,
    windowStart: addDays(nextStart, -2),
    windowEnd: addDays(nextStart, 2),
    ovulation,
    fertileStart: addDays(ovulation, -5),
    fertileEnd: ovulation,
    daysUntilNext: daysBetween(onDate, nextStart),
    cycleDay: daysBetween(lastStart, onDate) + 1,
    lastStart,
  };
};

/**
 * The expected day of the *current* cycle, for the calendar strip.
 *
 * Returns `EXPECTED` for every day of a predicted period that has not been logged, so the
 * calendar can show "expected" in a lighter treatment than "logged" — a forecast must
 * never look like a record.
 */
export type DayMark = 'NONE' | 'PERIOD' | 'EXPECTED' | 'FERTILE' | 'OVULATION';

export const markDay = (
  day: CalendarDate,
  days: readonly PeriodDay[],
  prediction: CyclePrediction | null,
): DayMark => {
  const logged = days.find((entry) => entry.date === day);
  if (logged !== undefined) return 'PERIOD';
  if (prediction === null) return 'NONE';

  const within = (start: CalendarDate, end: CalendarDate): boolean =>
    dayNumber(day) >= dayNumber(start) && dayNumber(day) <= dayNumber(end);

  if (within(prediction.nextStart, addDays(prediction.nextStart, prediction.periodLength - 1))) {
    return 'EXPECTED';
  }
  if (day === prediction.ovulation) return 'OVULATION';
  if (within(prediction.fertileStart, prediction.fertileEnd)) return 'FERTILE';
  return 'NONE';
};

/** Thirty days centred on today for the strip at the top of the screen. */
export const stripAround = (
  onDate: CalendarDate,
  before = 10,
  after = 19,
): readonly CalendarDate[] => {
  const dates: CalendarDate[] = [];
  for (let offset = -before; offset <= after; offset += 1) dates.push(addDays(onDate, offset));
  return dates;
};

/** The months in a year picker are 1-based, and February's length is a real question. */
export const daysIn = (year: number, month: number): number => daysInMonth(year, month);

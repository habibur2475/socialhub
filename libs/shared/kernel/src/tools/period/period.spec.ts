import { describe, expect, it } from 'vitest';

import {
  bleedStarts,
  averageCycleLength,
  averagePeriodLength,
  cycleRange,
  markDay,
  predictCycle,
  stripAround,
  validatePeriodDay,
  type PeriodDay,
} from './period.js';

const day = (date: string, flow: PeriodDay['flow'] = 'MEDIUM'): PeriodDay => ({
  date,
  flow,
  symptoms: [],
});

describe('validating a logged day', () => {
  it('refuses a future day, a malformed date and an unknown flow', () => {
    expect(validatePeriodDay(day('2026-11-22'), '2026-11-21')).toEqual({
      ok: false,
      error: { code: 'FUTURE_DAY' },
    });
    expect(validatePeriodDay(day('21-11-2026'), '2026-11-21')).toEqual({
      ok: false,
      error: { code: 'MALFORMED_DATE', value: '21-11-2026' },
    });
    expect(
      validatePeriodDay(
        { date: '2026-11-20', flow: 'TORRENTIAL' as never, symptoms: [] },
        '2026-11-21',
      ),
    ).toEqual({ ok: false, error: { code: 'UNKNOWN_FLOW' } });
  });

  it('normalises symptoms into a declared order without duplicates', () => {
    const result = validatePeriodDay(
      { date: '2026-11-20', flow: 'HEAVY', symptoms: ['MOOD', 'CRAMPS', 'MOOD'] },
      '2026-11-21',
    );
    expect(result).toEqual({
      ok: true,
      value: { date: '2026-11-20', flow: 'HEAVY', symptoms: ['CRAMPS', 'MOOD'] },
    });
  });
});

describe('cycle arithmetic', () => {
  const days = [
    day('2026-09-05'),
    day('2026-09-06'),
    day('2026-10-03'),
    day('2026-10-04'),
    day('2026-10-31'),
  ];

  it('finds the first day of each bleed, most recent first', () => {
    expect(bleedStarts(days)).toEqual(['2026-10-31', '2026-10-03', '2026-09-05']);
  });

  it('averages the recent gaps and ignores an implausible one', () => {
    // 28, 28, then a 400-day hole that is a missing log rather than a cycle.
    expect(averageCycleLength(['2026-11-01', '2026-10-04', '2026-09-06', '2025-08-02'])).toBe(28);
  });

  it('falls back to 28 days without two starts', () => {
    expect(averageCycleLength([])).toBe(28);
    expect(averageCycleLength(['2026-11-01'])).toBe(28);
  });

  it('reports the shortest and longest plausible gap, or nothing', () => {
    expect(cycleRange(['2026-09-06', '2026-10-04', '2026-11-01'])).toEqual({
      shortest: 28,
      longest: 28,
    });
    expect(cycleRange(['2026-11-01'])).toBeNull();
  });

  it('measures the typical bleed from the logged runs', () => {
    expect(averagePeriodLength(days)).toBe(2);
    expect(averagePeriodLength([])).toBe(5);
  });
});

describe('predictCycle', () => {
  const days = [day('2026-10-04'), day('2026-10-05'), day('2026-11-01'), day('2026-11-02')];

  it('predicts the next start, a five-day window and the fertile window', () => {
    const prediction = predictCycle(days, '2026-11-21');
    expect(prediction).not.toBeNull();
    if (prediction === null) return;

    expect(prediction.cycleLength).toBe(28);
    expect(prediction.nextStart).toBe('2026-11-29');
    expect(prediction.windowStart).toBe('2026-11-27');
    expect(prediction.windowEnd).toBe('2026-12-01');
    // Ovulation is anchored to the *next* period: 29 November minus 14.
    expect(prediction.ovulation).toBe('2026-11-15');
    expect(prediction.fertileStart).toBe('2026-11-10');
    expect(prediction.daysUntilNext).toBe(8);
    expect(prediction.cycleDay).toBe(21);
  });

  it('rolls forward when the predicted date has already passed', () => {
    expect(predictCycle([day('2026-09-01')], '2026-11-21')?.nextStart).toBe('2026-11-24');
  });

  it('has no prediction before anything has been logged', () => {
    expect(predictCycle([], '2026-11-21')).toBeNull();
    expect(predictCycle([], '2026-11-21')?.cycleDay).toBeUndefined();
  });
});

describe('markDay', () => {
  const days = [day('2026-11-01'), day('2026-11-02')];
  const prediction = predictCycle(days, '2026-11-21');

  it('marks a logged day, an expected day, the fertile window and ovulation', () => {
    expect(markDay('2026-11-01', days, prediction)).toBe('PERIOD');
    // 29 November is the predicted start.
    expect(markDay('2026-11-29', days, prediction)).toBe('EXPECTED');
    expect(markDay('2026-11-15', days, prediction)).toBe('OVULATION');
    expect(markDay('2026-11-12', days, prediction)).toBe('FERTILE');
    expect(markDay('2026-11-20', days, prediction)).toBe('NONE');
  });

  it('marks nothing beyond a logged day when there is no prediction', () => {
    expect(markDay('2026-11-01', days, null)).toBe('PERIOD');
    expect(markDay('2026-11-20', days, null)).toBe('NONE');
  });

  it('builds a strip that includes today', () => {
    const strip = stripAround('2026-11-21');
    expect(strip[0]).toBe('2026-11-11');
    expect(strip.at(-1)).toBe('2026-12-10');
    expect(strip).toContain('2026-11-21');
  });
});

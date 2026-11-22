'use client';

/**
 * The age calculator.
 *
 * Every number on this screen comes from `ageOn` in the kernel, which works in calendar
 * days. The point is not tidiness: the version of this tool that most people write does
 * `(now - birth) / 31557600000`, which is wrong by a day around leap years and wrong for
 * everyone whose birthday falls on a different side of the UTC line from the server.
 *
 * "Today" is read from the device, so it is the user's today, not the server's.
 */

import { useMemo, useState } from 'react';
import { Cake, CalendarDays } from 'lucide-react';

import { ageOn, checkBirthDate, parseCalendarDate, todayIn } from '@socialhub/kernel/browser';

import { ToolField, ToolShell, toolInputClass } from '@/components/tools/tool-shell';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const plural = (value: number, one: string, many = `${one}s`): string =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

export const AgeCalculatorTool = (): React.JSX.Element => {
  const today = todayIn(new Date());
  const [birth, setBirth] = useState('1995-06-15');
  const [onDate, setOnDate] = useState(today);

  const state = useMemo(() => {
    const birthDate = parseCalendarDate(birth);
    if (!birthDate.ok)
      return { kind: 'invalid' as const, message: birth === '' ? '' : 'That is not a date.' };

    const target = parseCalendarDate(onDate);
    if (!target.ok) return { kind: 'invalid' as const, message: 'That is not a date.' };

    const refusal = checkBirthDate(birthDate.value, target.value);
    if (refusal !== null) {
      return {
        kind: 'invalid' as const,
        message:
          refusal.code === 'BIRTH_DATE_IN_FUTURE'
            ? 'That birthday has not happened yet.'
            : 'That is more than 130 years ago — check the year.',
      };
    }

    return { kind: 'ok' as const, age: ageOn(birthDate.value, target.value) };
  }, [birth, onDate]);

  return (
    <ToolShell
      title="Age calculator"
      icon={Cake}
      description="Your age in years, months and days, the day of the week you were born on, and how long until the next birthday. Counted in calendar days, so leap years and timezones do not move it."
      handling="local"
      aside={
        state.kind === 'ok' ? (
          <>
            <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <span className="text-caption text-muted">Age</span>
              <p className="text-heading font-semibold tabular-nums">
                {state.age.years}
                <span className="ml-xs text-body font-normal text-muted">
                  {state.age.years === 1 ? 'year' : 'years'}
                </span>
              </p>
              <p className="text-small text-muted tabular-nums">
                {plural(state.age.months, 'month')} and {plural(state.age.days, 'day')}
              </p>
            </div>

            <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <span className="flex items-center gap-xs text-caption text-muted">
                <CalendarDays aria-hidden className="size-3" />
                Next birthday
              </span>
              <p className="text-body font-medium tabular-nums">
                turns {state.age.turning} on {state.age.nextBirthday}
              </p>
              <p className="text-small text-muted">
                {state.age.daysToNextBirthday === 0
                  ? 'Today.'
                  : `in ${plural(state.age.daysToNextBirthday, 'day')}`}
              </p>
            </div>
          </>
        ) : null
      }
    >
      <div className="flex flex-col gap-md">
        <div className="grid gap-md sm:grid-cols-2">
          <ToolField
            label="Date of birth"
            htmlFor="age-birth"
            hint="Use the real date; the month matters."
          >
            <input
              id="age-birth"
              type="date"
              value={birth}
              max={today}
              onChange={(event) => setBirth(event.target.value)}
              className={toolInputClass}
            />
          </ToolField>
          <ToolField
            label="Age on"
            htmlFor="age-on"
            hint="Change this to see an age at any past date."
          >
            <input
              id="age-on"
              type="date"
              value={onDate}
              onChange={(event) => setOnDate(event.target.value)}
              className={toolInputClass}
            />
          </ToolField>
        </div>

        {state.kind === 'invalid' ? (
          state.message === '' ? null : (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-sm py-xs text-small text-danger"
            >
              {state.message}
            </p>
          )
        ) : (
          <div className="grid gap-sm sm:grid-cols-3">
            {[
              { label: 'Days lived', value: state.age.totalDays },
              { label: 'Weeks lived', value: state.age.totalWeeks },
              { label: 'Months lived', value: state.age.totalMonths },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-border p-sm">
                <p className="text-caption text-muted">{item.label}</p>
                <p className="text-body font-semibold tabular-nums">
                  {item.value.toLocaleString()}
                </p>
              </div>
            ))}

            <p className="text-small text-muted sm:col-span-3">
              Born on a {WEEKDAYS[state.age.weekdayOfBirth]}.
              {state.age.weekdayOfBirth === 0 || state.age.weekdayOfBirth === 6
                ? ' A weekend birthday is a quiet party and a busy restaurant.'
                : ''}
            </p>
          </div>
        )}
      </div>
    </ToolShell>
  );
};

'use client';

/**
 * মেয়েদের পিরিয়ড ম্যানেজমেন্ট.
 *
 * The two things this screen must never do, and how it avoids them:
 *
 *   1. **Send the log anywhere.** There is no fetch in this file. The log is read and
 *      written with `localStorage`, the keys are namespaced, and the shell says so at the
 *      top. A tracker with no server cannot leak.
 *   2. **Speak with false confidence.** The prediction is a five-day window and the
 *      sentence around it says "most likely". Fertile days are described as an estimate,
 *      never as a verdict about whether someone can conceive.
 *
 * The strip is 30 days around today rather than a full month calendar: what a person wants
 * from a tracker on a Tuesday is "where am I and when is the next one", not a wall planner.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarHeart, Moon, Trash2 } from 'lucide-react';

import {
  FLOW_LABELS,
  FLOW_LEVELS,
  SYMPTOMS,
  SYMPTOM_LABELS,
  addDays,
  bleedStarts,
  cycleRange,
  markDay,
  predictCycle,
  stripAround,
  todayIn,
  type FlowLevel,
  type PeriodDay,
  type Symptom,
} from '@socialhub/kernel/browser';

import { ToolShell } from '@/components/tools/tool-shell';
import { cn } from '@/lib/cn';

const STORAGE_KEY = 'socialhub.tools.period.v1';

type Stored = { readonly days: readonly PeriodDay[] };

const loadDays = (): readonly PeriodDay[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as Stored;
    return Array.isArray(parsed.days) ? parsed.days : [];
  } catch {
    return [];
  }
};

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const weekdayOf = (date: string): number => {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day).getDay();
};

export const PeriodTool = (): React.JSX.Element => {
  const today = todayIn(new Date());
  const [days, setDays] = useState<readonly PeriodDay[]>([]);
  const [selected, setSelected] = useState(today);
  const [flow, setFlow] = useState<FlowLevel>('MEDIUM');
  const [symptoms, setSymptoms] = useState<readonly Symptom[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    setDays(loadDays());
  }, []);

  const persist = useCallback((next: readonly PeriodDay[]) => {
    setDays(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ days: next } satisfies Stored));
  }, []);

  const prediction = useMemo(() => predictCycle(days, today), [days, today]);
  const starts = useMemo(() => bleedStarts(days), [days]);
  const range = useMemo(() => cycleRange(starts), [starts]);

  const existing = days.find((day) => day.date === selected);

  const toggleSymptom = (symptom: Symptom): void => {
    setSymptoms((current) =>
      current.includes(symptom)
        ? current.filter((item) => item !== symptom)
        : [...current, symptom],
    );
  };

  const log = (): void => {
    const entry: PeriodDay = { date: selected, flow, symptoms };
    // A day already in the log is replaced, not duplicated: editing yesterday's flow should
    // not produce two rows for yesterday.
    persist(
      [...days.filter((day) => day.date !== selected), entry].sort((left, right) =>
        left.date < right.date ? -1 : 1,
      ),
    );
  };

  const remove = (date: string): void => {
    persist(days.filter((day) => day.date !== date));
  };

  const strip = stripAround(today);

  return (
    <ToolShell
      title="পিরিয়ড ট্র্যাকার"
      icon={CalendarHeart}
      description="পিরিয়ড কবে শুরু হলো, কেমন ছিল, আর পরেরটা কখন আসতে পারে — সব এই ব্রাউজারেই থাকে। কোনো সার্ভারে যায় না, কোনো অ্যাকাউন্টেও জমা হয় না। এটা একটা অনুমান, ডাক্তারি পরামর্শ নয়।"
      handling="local"
      aside={
        <>
          {prediction === null ? (
            <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <span className="text-caption text-muted">শুরু করুন</span>
              <p className="text-small text-muted">
                নিচের তারিখ থেকে প্রথম দিনটা লিখুন। দুই মাস লেখা হলে অনুমানটা আপনার নিজের চক্র
                অনুযায়ী হবে।
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
                <span className="text-caption text-muted">পরের পিরিয়ড</span>
                <p className="text-body font-semibold tabular-nums">{prediction.nextStart}</p>
                <p className="text-small text-muted">
                  সবচেয়ে সম্ভাব্য {prediction.windowStart} – {prediction.windowEnd} ·{' '}
                  {prediction.daysUntilNext === 0 ? 'আজ' : `${prediction.daysUntilNext} দিন পর`}
                </p>
                <p className="text-caption text-muted">
                  চক্র {prediction.cycleLength} দিন · পিরিয়ড {prediction.periodLength} দিন
                  {range === null ? '' : ` · ছোট ${range.shortest}, বড় ${range.longest}`}
                </p>
              </div>

              <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
                <span className="flex items-center gap-xs text-caption text-muted">
                  <Moon aria-hidden className="size-3" />
                  আনুমানিক ডিম্বস্ফোটন
                </span>
                <p className="text-body font-medium tabular-nums">{prediction.ovulation}</p>
                <p className="text-caption text-muted">
                  উর্বর সময় ধরা হচ্ছে {prediction.fertileStart} – {prediction.fertileEnd}। এটা
                  হিসাব, নিশ্চয়তা নয়।
                </p>
              </div>

              {prediction.cycleDay === null ? null : (
                <div className="rounded-lg border border-border p-md text-small">
                  চক্রের <span className="font-semibold">{prediction.cycleDay}</span> নম্বর দিন।
                </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => {
              if (confirmClear) {
                persist([]);
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
              }
            }}
            className={cn(
              'text-small underline',
              confirmClear ? 'font-medium text-danger' : 'text-muted',
            )}
          >
            {confirmClear ? 'নিশ্চিত? সব মুছে ফেলতে আবার চাপুন' : 'সব হিসাব মুছে ফেলুন'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-md">
        <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
          <span className="text-caption text-muted">আজ থেকে ৩০ দিন</span>
          <ol className="grid grid-cols-10 gap-[3px]" aria-label="Days around today">
            {strip.map((date) => {
              const mark = markDay(date, days, prediction);
              return (
                <li key={date}>
                  <button
                    type="button"
                    onClick={() => setSelected(date)}
                    aria-current={date === today ? 'date' : undefined}
                    aria-label={`${date}${
                      mark === 'PERIOD'
                        ? ', logged'
                        : mark === 'EXPECTED'
                          ? ', expected'
                          : mark === 'OVULATION'
                            ? ', estimated ovulation'
                            : mark === 'FERTILE'
                              ? ', fertile window'
                              : ''
                    }`}
                    className={cn(
                      'flex aspect-square w-full flex-col items-center justify-center rounded-md text-[10px] leading-none transition-colors',
                      mark === 'PERIOD'
                        ? 'bg-danger text-inverted'
                        : mark === 'EXPECTED'
                          ? 'border border-dashed border-danger/60 text-danger'
                          : mark === 'OVULATION'
                            ? 'bg-primary text-primary-contrast'
                            : mark === 'FERTILE'
                              ? 'bg-primary/15 text-primary'
                              : 'bg-raised text-muted',
                      date === today && 'ring-2 ring-foreground/40',
                      selected === date && 'ring-2 ring-primary',
                    )}
                  >
                    <span>{Number(date.slice(8))}</span>
                    <span className="opacity-70">{DAY_LABEL[weekdayOf(date)]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="text-caption text-muted">
            ঘরোয়া রঙ: লাল = লেখা হয়েছে, লাল ড্যাশ = সম্ভাব্য, নীল = উর্বর সময়, গাঢ় নীল =
            ডিম্বস্ফোটন।
          </p>
        </div>

        <div className="flex flex-col gap-sm rounded-lg border border-border p-md">
          <div className="flex flex-wrap items-baseline justify-between gap-sm">
            <h2 className="text-body font-medium">
              {selected === today ? 'আজ' : selected} {existing === undefined ? 'লিখুন' : 'সম্পাদনা'}
            </h2>
            {existing === undefined ? null : (
              <button
                type="button"
                onClick={() => remove(selected)}
                className="flex items-center gap-xs text-small text-danger underline"
              >
                <Trash2 aria-hidden className="size-3" />
                এই দিনটা মুছুন
              </button>
            )}
          </div>

          <fieldset className="flex flex-wrap gap-xs">
            <legend className="mb-xs text-small font-medium">কেমন ছিল</legend>
            {FLOW_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setFlow(level)}
                aria-pressed={flow === level}
                className={cn(
                  'h-9 rounded-full px-sm text-small transition-colors',
                  flow === level
                    ? 'bg-danger/10 font-medium text-danger'
                    : 'bg-raised text-muted hover:text-text',
                )}
              >
                {FLOW_LABELS[level]}
              </button>
            ))}
          </fieldset>

          <fieldset className="flex flex-wrap gap-xs">
            <legend className="mb-xs text-small font-medium">উপসর্গ (ঐচ্ছিক)</legend>
            {SYMPTOMS.map((symptom) => (
              <button
                key={symptom}
                type="button"
                onClick={() => toggleSymptom(symptom)}
                aria-pressed={symptoms.includes(symptom)}
                className={cn(
                  'h-9 rounded-full px-sm text-small transition-colors',
                  symptoms.includes(symptom)
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'bg-raised text-muted hover:text-text',
                )}
              >
                {SYMPTOM_LABELS[symptom]}
              </button>
            ))}
          </fieldset>

          <button
            type="button"
            onClick={() => {
              setFlow(existing?.flow ?? 'MEDIUM');
              setSymptoms(existing?.symptoms ?? []);
              log();
            }}
            className={cn(
              'h-11 self-start rounded-md bg-primary px-md text-small font-medium text-primary-contrast transition-colors hover:bg-primary-hover',
            )}
          >
            {existing === undefined ? 'দিনটা সংরক্ষণ করুন' : 'পরিবর্তন সংরক্ষণ করুন'}
          </button>
        </div>

        {days.length === 0 ? null : (
          <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
            <span className="text-caption text-muted">লেখা দিনগুলো</span>
            <ul className="flex flex-col divide-y divide-border">
              {[...days]
                .reverse()
                .slice(0, 40)
                .map((day) => (
                  <li key={day.date} className="flex items-center gap-sm py-xs text-small">
                    <span className="tabular-nums">{day.date}</span>
                    <span className="text-muted">{FLOW_LABELS[day.flow]}</span>
                    {day.symptoms.length === 0 ? null : (
                      <span className="truncate text-caption text-muted">
                        {day.symptoms.map((symptom) => SYMPTOM_LABELS[symptom]).join(', ')}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(day.date)}
                      aria-label={`Delete ${day.date}`}
                      className="ml-auto rounded-sm p-xs text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 aria-hidden className="size-3" />
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}

        <p className="rounded-md bg-raised p-sm text-caption text-muted">
          প্রতি মাসে চক্র বদলাতে পারে, আর অনিয়মিত চক্রে এই হিসাব মিলবে না। গর্ভধারণ এড়াতে বা
          পরিকল্পনা করতে এটাকে ভরসা করবেন না — ডাক্তারের পরামর্শ নিন। পরের দিন: {addDays(today, 1)}।
        </p>
      </div>
    </ToolShell>
  );
};

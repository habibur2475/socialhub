'use client';

/**
 * দৈনন্দিন আয়-ব্যয়ের হিসাব.
 *
 * The ledger is kept in the browser and nowhere else. That is a decision about who carries
 * the risk: the income and the pharmacies in this list are the most personal data the
 * product holds, and a tool that has no server cannot lose them.
 *
 * Amounts are integers of paisa from the moment they are parsed (`amountFromInput`) to the
 * moment they are rendered (`format` from the kernel's money module). Nothing here adds
 * floats.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Wallet } from 'lucide-react';

import {
  CATEGORY_LABELS,
  DIRECTION_LABELS,
  ENTRY_DIRECTIONS,
  EXPENSE_CATEGORIES,
  amountFromInput,
  dailyTotals,
  format as formatMoney,
  monthRange,
  spanBetween,
  summariseLedger,
  todayIn,
  type CalendarDate,
  type EntryDirection,
  type ExpenseCategory,
  type LedgerEntry,
} from '@socialhub/kernel/browser';

import { ToolField, ToolShell, toolInputClass } from '@/components/tools/tool-shell';
import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';

const STORAGE_KEY = 'socialhub.tools.budget.v1';

type Stored = { readonly entries: readonly LedgerEntry[] };

const load = (): readonly LedgerEntry[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as Stored;
    // A hand-edited or half-written value must not take the page down with it.
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
};

const monthOf = (date: CalendarDate): string => date.slice(0, 7);

export const BudgetTool = (): React.JSX.Element => {
  const today = todayIn(new Date());
  const [month, setMonth] = useState(monthOf(today));
  const [entries, setEntries] = useState<readonly LedgerEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [direction, setDirection] = useState<EntryDirection>('EXPENSE');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('FOOD');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries(load());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    // Written on every change rather than on a save button: a ledger that can lose an entry
    // because someone closed the tab is a ledger nobody trusts.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries } satisfies Stored));
  }, [entries, loaded]);

  const [year, monthNumber] = month.split('-').map(Number);
  const range = monthRange(year ?? 2026, monthNumber ?? 1);
  const inMonth = useMemo(
    () => entries.filter((entry) => monthOf(entry.date) === month),
    [entries, month],
  );

  const summary = useMemo(
    () => summariseLedger(inMonth, { spanDays: spanBetween(range.from, range.to) }),
    [inMonth, range.from, range.to],
  );

  const days = useMemo(
    () => dailyTotals(inMonth, range.from, range.to),
    [inMonth, range.from, range.to],
  );

  const highestDay = days.reduce((highest, day) => Math.max(highest, day.spent), 0);

  const add = useCallback((): void => {
    const parsed = amountFromInput(amount);
    if (!parsed.ok) {
      setError('Write an amount, like 250 or 1,250.50.');
      return;
    }
    if (parsed.value.minor <= 0) {
      setError('An amount has to be more than zero — a refund is income, not a negative expense.');
      return;
    }

    setEntries((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date,
        direction,
        minor: parsed.value.minor,
        category,
        note: note.trim(),
      },
    ]);
    setAmount('');
    setNote('');
    setError(null);
  }, [amount, category, date, direction, note]);

  const remove = (id: string): void => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const sorted = [...inMonth].sort((left, right) => (left.date < right.date ? 1 : -1));

  return (
    <ToolShell
      title="দৈনন্দিন আয়-ব্যয়ের হিসাব"
      icon={Wallet}
      description="দিনে দিনে আয় আর খরচ লিখে রাখুন, মাসের শেষে দেখুন কোথায় টাকা যাচ্ছে। সব হিসাব আপনার ব্রাউজারেই থাকে — কোথাও আপলোড হয় না, তাই ফোন বদলালে হিসাবও থাকবে না।"
      handling="local"
      aside={
        <>
          <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
            <span className="text-caption text-muted">এই মাসে</span>
            <p className="text-subheading font-semibold tabular-nums">
              ৳ {formatMoney({ currency: 'BDT', minor: summary.remaining })}
            </p>
            <p className="text-small text-muted">
              {summary.remaining >= 0 ? 'বাকি আছে' : 'আয়ের চেয়ে বেশি খরচ'}
            </p>
            <dl className="mt-xs flex flex-col gap-xs text-small">
              <div className="flex justify-between">
                <dt className="text-muted">{DIRECTION_LABELS.INCOME}</dt>
                <dd className="tabular-nums">
                  ৳ {formatMoney({ currency: 'BDT', minor: summary.income })}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">{DIRECTION_LABELS.EXPENSE}</dt>
                <dd className="tabular-nums">
                  ৳ {formatMoney({ currency: 'BDT', minor: summary.spent })}
                </dd>
              </div>
              {summary.averageDailySpend === null ? null : (
                <div className="flex justify-between">
                  <dt className="text-muted">দিনে গড়ে</dt>
                  <dd className="tabular-nums">
                    ৳ {formatMoney({ currency: 'BDT', minor: summary.averageDailySpend })}
                  </dd>
                </div>
              )}
            </dl>
            {summary.remaining < 0 ? (
              <p className="text-caption text-danger">
                ৳ {formatMoney({ currency: 'BDT', minor: summary.overspentBy })} বেশি খরচ হয়েছে।
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
            <span className="text-caption text-muted">খরচের ভাগ</span>
            {summary.spent === 0 ? (
              <p className="text-small text-muted">এখনও কোনো খরচ লেখা হয়নি।</p>
            ) : (
              summary.buckets
                .filter((bucket) => bucket.minor > 0)
                .sort((left, right) => right.minor - left.minor)
                .map((bucket) => (
                  <div key={bucket.category} className="flex flex-col gap-[2px]">
                    <div className="flex justify-between text-small">
                      <span>{bucket.label}</span>
                      <span className="tabular-nums text-muted">
                        ৳ {formatMoney({ currency: 'BDT', minor: bucket.minor })}
                      </span>
                    </div>
                    <div className="h-[6px] overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${bucket.percent}%` }}
                      />
                    </div>
                  </div>
                ))
            )}
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-md">
        <div className="flex flex-wrap items-end gap-sm">
          <ToolField label="মাস" htmlFor="budget-month">
            <input
              id="budget-month"
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              className={toolInputClass}
            />
          </ToolField>
        </div>

        <form
          className="flex flex-col gap-sm rounded-lg border border-border p-md"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="flex flex-wrap gap-xs">
            {ENTRY_DIRECTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDirection(option)}
                aria-pressed={direction === option}
                className={cn(
                  'h-9 rounded-full px-sm text-small transition-colors',
                  direction === option
                    ? option === 'INCOME'
                      ? 'bg-success/10 font-medium text-success'
                      : 'bg-danger/10 font-medium text-danger'
                    : 'bg-raised text-muted hover:text-text',
                )}
              >
                {DIRECTION_LABELS[option]}
              </button>
            ))}
          </div>

          <div className="grid gap-sm sm:grid-cols-2">
            <ToolField label="টাকার পরিমাণ" htmlFor="budget-amount">
              <input
                id="budget-amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="২৫০"
                className={toolInputClass}
              />
            </ToolField>

            <ToolField label="তারিখ" htmlFor="budget-date">
              <input
                id="budget-date"
                type="date"
                value={date}
                max={today}
                onChange={(event) => setDate(event.target.value)}
                className={toolInputClass}
              />
            </ToolField>

            <ToolField label="খাত" htmlFor="budget-category">
              <select
                id="budget-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as ExpenseCategory)}
                className={toolInputClass}
              >
                {EXPENSE_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {CATEGORY_LABELS[option]}
                  </option>
                ))}
              </select>
            </ToolField>

            <ToolField label="বিবরণ" htmlFor="budget-note" hint="যেমন: বাজার, রিকশা, বিদ্যুৎ বিল">
              <input
                id="budget-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={80}
                className={toolInputClass}
              />
            </ToolField>
          </div>

          {error === null ? null : (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          )}

          <button type="submit" className={cn(buttonClass('primary', 'sm'), 'self-start')}>
            <Plus aria-hidden className="size-4" />
            যোগ করুন
          </button>
        </form>

        {highestDay > 0 ? (
          <div className="flex flex-col gap-xs rounded-lg border border-border p-md">
            <span className="text-caption text-muted">দিনে দিনে খরচ</span>
            <ol className="flex h-16 items-end gap-[2px]" aria-label="Daily spending this month">
              {days.map((day) => (
                <li
                  key={day.date}
                  className="flex-1"
                  title={`${day.date}: ${formatMoney({ currency: 'BDT', minor: day.spent })}`}
                >
                  <div
                    className={cn(
                      'w-full rounded-t-sm',
                      day.spent === 0 ? 'bg-raised' : 'bg-primary/70',
                    )}
                    style={{
                      height: `${Math.max(2, Math.round((day.spent / highestDay) * 64))}px`,
                    }}
                  />
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {sorted.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-lg text-center text-small text-muted">
            এই মাসে এখনও কিছু লেখা হয়নি। উপরে প্রথম এন্ট্রিটা যোগ করুন।
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {sorted.map((entry) => (
              <li key={entry.id} className="flex items-center gap-sm p-sm">
                <span className="w-[68px] shrink-0 text-caption tabular-nums text-muted">
                  {entry.date.slice(5)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small">
                    {entry.note === '' ? CATEGORY_LABELS[entry.category] : entry.note}
                  </span>
                  <span className="text-caption text-muted">{CATEGORY_LABELS[entry.category]}</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 text-small font-medium tabular-nums',
                    entry.direction === 'INCOME' ? 'text-success' : 'text-text',
                  )}
                >
                  {entry.direction === 'INCOME' ? '+' : '−'} ৳{' '}
                  {formatMoney({ currency: 'BDT', minor: entry.minor })}
                </span>
                <button
                  type="button"
                  onClick={() => remove(entry.id)}
                  aria-label={`Delete ${entry.note === '' ? CATEGORY_LABELS[entry.category] : entry.note} from ${entry.date}`}
                  className="rounded-sm p-xs text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ToolShell>
  );
};

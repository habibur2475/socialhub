'use client';

/**
 * Posting a job.
 *
 * One form, two buttons: "publish" and "save as draft". A draft has no deadline pressure and is
 * visible to nobody but its author — which is the whole point of having one, since deciding on a
 * budget usually takes a day.
 *
 * The deadline is a `date` input and the request wants an instant, so the conversion happens
 * once, here, at the end of the day the client picked. Sending midnight would make a job vanish
 * from the board a day earlier than the client expected, which is the kind of off-by-one nobody
 * reports and everybody notices.
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import {
  WORK_CURRENCIES,
  createJobRequestSchema,
  type CreateJobRequestInput,
  type WorkCurrency,
} from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createWorkApi } from '@/lib/work-api';
import { useSession } from '@/lib/session';

const CATEGORIES = ['writing', 'design', 'development', 'translation', 'video', 'general'] as const;

/** The last instant of the chosen day, in the browser's own timezone. */
const endOfDay = (date: string): string => {
  const [year = '1970', month = '01', day = '01'] = date.split('-');
  return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59).toISOString();
};

export const JobEditor = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('writing');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState<WorkCurrency>('BDT');
  const [deadline, setDeadline] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  /** What the client's own number means, before it is sent. */
  const preview = useMemo(
    () =>
      createJobRequestSchema
        .pick({ budget: true })
        .safeParse({ budget: budget === '' ? '0' : budget }),
    [budget],
  );

  const submit = async (status: 'DRAFT' | 'OPEN'): Promise<void> => {
    if (busy || deadline === '') {
      if (deadline === '') setIssues({ deadline: 'Choose a date, even for a draft' });
      return;
    }

    const draft: CreateJobRequestInput = {
      title,
      description,
      category,
      budget,
      currency,
      deadline: endOfDay(deadline),
      status,
    };

    const parsed = createJobRequestSchema.safeParse(draft);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues)
        next[issue.path.join('.') || '_form'] ??= issue.message;
      setIssues(next);
      setError(null);
      return;
    }

    setIssues({});
    setBusy(true);
    setError(null);

    try {
      const created = await createWorkApi(client).createJob(draft);
      router.push(`/work/${created.id}`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const issue = (key: string): string | undefined => issues[key];

  return (
    <div className="flex flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Post a job</h1>
        <p className="text-body text-muted">
          Say what needs doing and what it is worth. A draft is private; publishing puts it on the
          board until the deadline you choose.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit('OPEN');
        }}
        className="flex flex-col gap-md"
      >
        <Field
          label="What needs doing?"
          htmlFor="job-title"
          required
          hint="One line, the way you would say it to a friend"
          {...(issue('title') === undefined ? {} : { error: issue('title') })}
        >
          <Input
            id="job-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            required
          />
        </Field>

        <Field
          label="The brief"
          htmlFor="job-description"
          hint="What done looks like, and anything you have already prepared"
          {...(issue('description') === undefined ? {} : { error: issue('description') })}
        >
          <textarea
            id="job-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={6}
            maxLength={8_000}
            className="resize-y rounded-md border border-border-strong/40 bg-surface p-sm text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          />
        </Field>

        <div className="grid gap-md sm:grid-cols-2">
          <Field label="Category" htmlFor="job-category">
            <select
              id="job-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-11 w-full rounded-md border border-border-strong/40 bg-surface px-sm text-body text-text"
            >
              {CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Deadline"
            htmlFor="job-deadline"
            required
            hint="The job stops taking proposals at the end of this day"
            {...(issue('deadline') === undefined ? {} : { error: issue('deadline') })}
          >
            <Input
              id="job-deadline"
              type="date"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              required
            />
          </Field>
        </div>

        <div className="grid gap-md sm:grid-cols-2">
          <Field
            label="Budget"
            htmlFor="job-budget"
            required
            hint={
              preview.success
                ? `${(preview.data.budget / 100).toFixed(2)} exactly`
                : 'At least 50.00 — like 250 or 2500.50'
            }
            {...(issue('budget') === undefined ? {} : { error: issue('budget') })}
          >
            <Input
              id="job-budget"
              value={budget}
              inputMode="decimal"
              placeholder="2500"
              onChange={(event) => setBudget(event.target.value)}
              required
            />
          </Field>

          <Field label="Currency" htmlFor="job-currency">
            <select
              id="job-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value as WorkCurrency)}
              className="h-11 w-full rounded-md border border-border-strong/40 bg-surface px-sm text-body text-text"
            >
              {WORK_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error === null ? null : (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="submit"
            disabled={busy || sessionStatus !== 'authenticated'}
            className={buttonClass('primary', 'md')}
          >
            {busy ? 'Saving…' : 'Publish the job'}
          </button>
          <button
            type="button"
            onClick={() => void submit('DRAFT')}
            disabled={busy}
            className={buttonClass('secondary', 'md')}
          >
            Save as draft
          </button>
          <button
            type="button"
            onClick={() => router.push('/work')}
            className={cn(buttonClass('ghost', 'md'), 'ml-auto')}
          >
            <ArrowLeft aria-hidden className="size-4" />
            Back
          </button>
        </div>
      </form>
    </div>
  );
};

'use client';

/**
 * Taking a quiz.
 *
 * The state machine is deliberately small and honest:
 *
 *   idle        the set is shown with a Start button. Nothing is attempted until the
 *               user commits, because starting an attempt is a write.
 *   running     an attempt exists on the server. Answers are local until submit; a
 *               reload resumes the same attempt rather than creating a second one.
 *   reviewing   the attempt is graded. The key is now visible, every question is
 *               explained, and the same view is what a re-read produces.
 *
 * Two details that matter:
 *
 *   * **A timed attempt shows a countdown derived from `startedAt`**, not from a local
 *     timer that started when the tab opened. A resumed attempt must show the time it
 *     actually has left, and a suspended laptop must not appear to have paused it.
 *   * **Submitting sends every question, including the unanswered ones.** A skipped
 *     question is a deliberate "I do not know", and the server grades it as wrong but
 *     counts it against the total — which is the only reading that makes a score mean
 *     something.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CircleCheck, CircleX, Clock } from 'lucide-react';

import type {
  QuizAttemptResponse,
  QuizQuestionResponse,
  QuizSetResponse,
} from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { FormError } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createQuizApi } from '@/lib/quiz-api';
import { useSession } from '@/lib/session';

type Phase = 'idle' | 'running' | 'reviewing';

const remainingSeconds = (startedAt: string, limitSeconds: number, now: Date): number => {
  const elapsed = Math.floor((now.getTime() - new Date(startedAt).getTime()) / 1_000);
  return Math.max(limitSeconds - elapsed, 0);
};

const formatClock = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const QuizRunner = ({
  set,
  initialAttempt,
}: {
  readonly set: QuizSetResponse;
  readonly initialAttempt: QuizAttemptResponse | null;
}): React.JSX.Element => {
  const { client } = useSession();
  const api = useMemo(() => createQuizApi(client), [client]);

  const [attempt, setAttempt] = useState<QuizAttemptResponse | null>(initialAttempt);
  const [phase, setPhase] = useState<Phase>(
    initialAttempt !== null && initialAttempt.submittedAt !== null
      ? 'reviewing'
      : initialAttempt !== null
        ? 'running'
        : 'idle',
  );

  /** Selected option ids per question. A question with an empty array is skipped. */
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Pre-fill from a resumed attempt, so answers already given are not lost when the
  // page is reopened.
  useEffect(() => {
    if (initialAttempt === null) return;
    const restored: Record<string, string[]> = {};
    for (const result of initialAttempt.results) {
      restored[result.questionId] = [...result.selectedOptionIds];
    }
    setSelection(restored);
  }, [initialAttempt]);

  // One interval drives both the countdown and nothing else; `now` is state so the
  // clock re-renders, and the interval is cleared the moment the attempt is graded.
  useEffect(() => {
    if (phase !== 'running' || set.timeLimitSeconds === null) return;

    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, [phase, set.timeLimitSeconds]);

  const start = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);

    try {
      const created = await api.startAttempt(set.id);
      setAttempt(created);
      setPhase('running');
      setNow(new Date());
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [api, set.id]);

  const toggle = (question: QuizQuestionResponse, optionId: string): void => {
    setSelection((current) => {
      const picked = current[question.id] ?? [];

      // A single-correct question behaves like radio buttons: picking a second option
      // replaces the first, which is what the author intended when they marked one
      // option correct.
      const correctCount = question.options.filter((option) => option.isCorrect === true).length;
      const single =
        correctCount === 1 || question.options.every((option) => option.isCorrect === null);

      if (picked.includes(optionId)) {
        return { ...current, [question.id]: picked.filter((id) => id !== optionId) };
      }

      return { ...current, [question.id]: single ? [optionId] : [...picked, optionId] };
    });
  };

  const submit = async (): Promise<void> => {
    if (attempt === null) return;

    setBusy(true);
    setError(null);

    try {
      const graded = await api.submitAttempt(attempt.id, {
        answers: set.questions.map((question) => ({
          questionId: question.id,
          selectedOptionIds: selection[question.id] ?? [],
        })),
      });
      setAttempt(graded);
      setPhase('reviewing');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const limit = set.timeLimitSeconds;
  const left =
    attempt === null || limit === null ? null : remainingSeconds(attempt.startedAt, limit, now);

  return (
    <div className="flex flex-col gap-md">
      {error === null ? null : <FormError>{error}</FormError>}

      {phase === 'idle' ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border bg-surface p-md">
          <p className="text-body">
            {set.questionCount} {set.questionCount === 1 ? 'question' : 'questions'}
            {limit === null ? ', untimed' : `, ${String(Math.round(limit / 60))} minutes`}.
          </p>
          <p className="text-small text-muted">
            Your answers are graded when you submit. The answer key stays hidden until then.
          </p>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy}
            className={buttonClass('primary', 'md')}
          >
            {busy ? 'Starting…' : 'Start attempt'}
          </button>
        </div>
      ) : null}

      {phase === 'running' && left !== null ? (
        <p
          className={cn(
            'inline-flex items-center gap-xs self-start rounded-md px-sm py-xs text-small tabular-nums',
            left <= 60 ? 'bg-danger-surface text-danger' : 'bg-raised text-muted',
          )}
          // Announced politely: a screen reader user needs the warning, not a countdown
          // narrated every second.
          aria-live={left <= 60 ? 'polite' : 'off'}
        >
          <Clock aria-hidden className="size-4" />
          {left === 0 ? 'Time is up — submit to be graded' : `${formatClock(left)} remaining`}
        </p>
      ) : null}

      <ol className="flex flex-col gap-md">
        {set.questions.map((question, index) => {
          const picked = selection[question.id] ?? [];
          const result = attempt?.results.find((entry) => entry.questionId === question.id);
          const reviewing = phase === 'reviewing' && result !== undefined;

          return (
            <li key={question.id} className="rounded-lg border border-border bg-surface p-md">
              <fieldset>
                <legend className="mb-sm text-body font-medium">
                  <span className="text-muted">{index + 1}. </span>
                  {question.prompt}
                </legend>

                <div className="flex flex-col gap-xs">
                  {question.options.map((option) => {
                    const isPicked = picked.includes(option.id);
                    // In review, the key is available: mark the correct option and the
                    // one that was chosen, independently — a wrong pick and the right
                    // answer must both be visible.
                    const isKey = reviewing && result.correctOptionIds.includes(option.id);
                    const isWrongPick = reviewing && isPicked && !isKey;

                    return (
                      <label
                        key={option.id}
                        className={cn(
                          'flex cursor-pointer items-start gap-sm rounded-md border px-sm py-xs text-small',
                          'transition-colors duration-fast',
                          isKey && 'border-success bg-success-surface',
                          isWrongPick && 'border-danger bg-danger-surface',
                          !isKey && !isWrongPick && isPicked && 'border-primary bg-primary/10',
                          !isKey && !isWrongPick && !isPicked && 'border-border',
                          phase === 'reviewing' && 'cursor-default',
                        )}
                      >
                        <input
                          type={
                            question.options.some((entry) => entry.isCorrect === null)
                              ? 'checkbox'
                              : 'radio'
                          }
                          name={`question-${question.id}`}
                          checked={isPicked}
                          disabled={phase !== 'running'}
                          onChange={() => toggle(question, option.id)}
                          className="mt-[2px]"
                        />
                        <span className="flex-1">{option.label}</span>
                        {isKey ? (
                          <CircleCheck
                            aria-label="Correct answer"
                            className="size-4 text-success"
                          />
                        ) : null}
                        {isWrongPick ? (
                          <CircleX aria-label="Your answer" className="size-4 text-danger" />
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {reviewing && !result.correct && picked.length === 0 ? (
                <p className="mt-xs text-caption text-muted">You left this one blank.</p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {phase === 'running' ? (
        <div className="flex items-center gap-sm">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={buttonClass('primary', 'md')}
          >
            <Check aria-hidden className="size-4" />
            {busy ? 'Grading…' : 'Submit answers'}
          </button>
          <p className="text-small text-muted">
            {set.questions.filter((question) => (selection[question.id] ?? []).length > 0).length}{' '}
            of {set.questions.length} answered
          </p>
        </div>
      ) : null}

      {phase === 'reviewing' && attempt !== null ? (
        <div className="flex flex-col gap-xs rounded-lg border border-border bg-surface p-md">
          <p className="text-subheading">
            {attempt.score} / {attempt.maxScore}
            <span className="ml-xs text-small text-muted">({attempt.percentage ?? 0}%)</span>
          </p>
          {attempt.expired ? (
            <p className="text-small text-warning">
              Submitted after the time limit. The attempt was graded as it stood.
            </p>
          ) : null}
          <p className="text-small text-muted">
            The key is shown because this attempt is graded. Starting another attempt hides it
            again.
          </p>
        </div>
      ) : null}
    </div>
  );
};

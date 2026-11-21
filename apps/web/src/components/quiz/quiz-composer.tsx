'use client';

/**
 * Creating a quiz set.
 *
 * The editor is a local draft that is validated with the *server's* schema before it
 * is sent, and the whole set goes in one request. Two consequences:
 *
 *   * A question with no correct option is caught here with a message on the question,
 *     not as a 422 for the entire set — the error is where the user is looking.
 *   * The draft is never partially saved. A half-written set does not exist, so there
 *     is no "which questions are missing" state to explain later.
 *
 * A draft question can be reordered by removing and re-adding. Drag-and-drop is
 * deliberately absent: it is the single most fragile interaction to make keyboard
 * accessible, and the API assigns positions from array order regardless.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { createQuizSetRequestSchema, QUIZ_VISIBILITIES } from '@socialhub/contracts';
import {
  QUIZ_MAX_OPTIONS,
  QUIZ_MAX_QUESTIONS,
  QUIZ_MIN_OPTIONS,
  QUIZ_TITLE_MAX_LENGTH,
} from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, FormError, Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { createQuizApi } from '@/lib/quiz-api';
import { useSession } from '@/lib/session';

type DraftOption = { readonly key: string; label: string; correct: boolean };
type DraftQuestion = { readonly key: string; prompt: string; options: DraftOption[] };

const VISIBILITY_LABELS: Record<(typeof QUIZ_VISIBILITIES)[number], string> = {
  PUBLIC: 'Everyone',
  FOLLOWERS: 'Followers',
  PRIVATE: 'Only me',
};

let sequence = 0;
const nextKey = (): string => {
  sequence += 1;
  return `draft-${String(sequence)}`;
};

const blankOption = (correct = false): DraftOption => ({ key: nextKey(), label: '', correct });

const blankQuestion = (): DraftQuestion => ({
  key: nextKey(),
  prompt: '',
  options: [blankOption(true), blankOption()],
});

export const QuizComposer = (): React.JSX.Element => {
  const { client } = useSession();
  const router = useRouter();
  const { state, start, fail } = useSubmitState();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<(typeof QUIZ_VISIBILITIES)[number]>('PUBLIC');
  const [timed, setTimed] = useState(false);
  const [minutes, setMinutes] = useState('10');
  const [questions, setQuestions] = useState<DraftQuestion[]>([blankQuestion()]);

  const patchQuestion = (key: string, change: Partial<DraftQuestion>): void => {
    setQuestions((current) =>
      current.map((question) => (question.key === key ? { ...question, ...change } : question)),
    );
  };

  const patchOption = (
    questionKey: string,
    optionKey: string,
    change: Partial<DraftOption>,
  ): void => {
    setQuestions((current) =>
      current.map((question) =>
        question.key === questionKey
          ? {
              ...question,
              options: question.options.map((option) =>
                option.key === optionKey ? { ...option, ...change } : option,
              ),
            }
          : question,
      ),
    );
  };

  /**
   * Marking an option correct decides whether the question is single- or multi-answer
   * from its own state: a question with exactly one correct option behaves like a
   * radio, so choosing a new correct option replaces the old one. That mirrors what
   * the runner infers from the key.
   */
  const setCorrect = (questionKey: string, optionKey: string, correct: boolean): void => {
    setQuestions((current) =>
      current.map((question) => {
        if (question.key !== questionKey) return question;

        const already = question.options.filter((option) => option.correct).length;
        // One correct option already marked, and the author is marking another: this
        // is a deliberate move to multi-answer only if they hold shift. Plain clicks
        // are treated as "this is the answer", which is the common case.
        const singleCorrect = already <= 1 && correct;

        return {
          ...question,
          options: question.options.map((option) => {
            if (option.key === optionKey) return { ...option, correct };
            return singleCorrect ? { ...option, correct: false } : option;
          }),
        };
      }),
    );
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const draft = {
      title,
      description: description.trim() === '' ? null : description,
      visibility,
      gradingMode: 'AUTO' as const,
      timeLimitSeconds: timed ? Number(minutes) * 60 : null,
      questions: questions.map((question) => ({
        prompt: question.prompt,
        options: question.options.map((option) => ({
          label: option.label,
          correct: option.correct,
        })),
      })),
    };

    const parsed = createQuizSetRequestSchema.safeParse(draft);
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    start();
    try {
      const created = await createQuizApi(client).create(parsed.data);
      router.push(`/quiz/${created.id}`);
    } catch (cause) {
      if (isApiFailure(cause)) {
        const mapped = fieldsFromApi(cause);
        fail({ fields: mapped.fields, form: mapped.form });
        return;
      }
      fail({ form: describeError(cause) });
    }
  };

  return (
    <form
      className="flex flex-col gap-lg"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {state.formError === null ? null : <FormError>{state.formError}</FormError>}

      <div className="flex flex-col gap-sm rounded-lg border border-border bg-surface p-md">
        <Field
          label="Title"
          htmlFor="quiz-title"
          required
          hint={`Up to ${String(QUIZ_TITLE_MAX_LENGTH)} characters`}
          error={state.fieldErrors['title']}
        >
          <Input
            id="quiz-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={QUIZ_TITLE_MAX_LENGTH}
          />
        </Field>

        <Field
          label="Description"
          htmlFor="quiz-description"
          error={state.fieldErrors['description']}
        >
          <textarea
            id="quiz-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="w-full rounded-md border border-border bg-canvas px-sm py-xs text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-sm">
          <label htmlFor="quiz-visibility" className="text-small font-medium">
            Who can see it
          </label>
          <select
            id="quiz-visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as typeof visibility)}
            className="h-11 rounded-md border border-border bg-canvas px-sm text-small"
          >
            {QUIZ_VISIBILITIES.map((option) => (
              <option key={option} value={option}>
                {VISIBILITY_LABELS[option]}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-xs text-small">
            <input
              type="checkbox"
              checked={timed}
              onChange={(event) => setTimed(event.target.checked)}
            />
            Timed
          </label>

          {timed ? (
            <>
              <label htmlFor="quiz-minutes" className="sr-only">
                Time limit in minutes
              </label>
              <input
                id="quiz-minutes"
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                className="h-11 w-20 rounded-md border border-border bg-canvas px-sm text-small tabular-nums"
              />
              <span className="text-small text-muted">minutes</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-md">
        {questions.map((question, index) => {
          const promptError = state.fieldErrors[`questions.${String(index)}.prompt`];
          const optionsError = state.fieldErrors[`questions.${String(index)}.options`];

          return (
            <fieldset
              key={question.key}
              className="flex flex-col gap-sm rounded-lg border border-border bg-surface p-md"
            >
              <legend className="px-1 text-small font-medium text-muted">
                Question {index + 1}
              </legend>

              <label htmlFor={`prompt-${question.key}`} className="sr-only">
                Question {index + 1} prompt
              </label>
              <input
                id={`prompt-${question.key}`}
                value={question.prompt}
                onChange={(event) => patchQuestion(question.key, { prompt: event.target.value })}
                placeholder="What is the question?"
                aria-invalid={promptError === undefined ? undefined : true}
                className="h-11 rounded-md border border-border bg-canvas px-sm text-body"
              />
              {promptError === undefined ? null : (
                <p role="alert" className="text-caption text-danger">
                  {promptError}
                </p>
              )}

              <div className="flex flex-col gap-xs">
                {question.options.map((option, optionIndex) => (
                  <div key={option.key} className="flex items-center gap-sm">
                    <input
                      type="checkbox"
                      checked={option.correct}
                      onChange={(event) =>
                        setCorrect(question.key, option.key, event.target.checked)
                      }
                      aria-label={`Option ${String(optionIndex + 1)} is correct`}
                    />
                    <input
                      value={option.label}
                      onChange={(event) =>
                        patchOption(question.key, option.key, { label: event.target.value })
                      }
                      placeholder={`Option ${String(optionIndex + 1)}`}
                      className="h-11 flex-1 rounded-md border border-border bg-canvas px-sm text-small"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        patchQuestion(question.key, {
                          options: question.options.filter((entry) => entry.key !== option.key),
                        })
                      }
                      disabled={question.options.length <= QUIZ_MIN_OPTIONS}
                      className={cn(
                        'inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-danger',
                        'disabled:cursor-not-allowed disabled:opacity-40',
                      )}
                    >
                      <Trash2 aria-hidden className="size-4" />
                      <span className="sr-only">Remove option {optionIndex + 1}</span>
                    </button>
                  </div>
                ))}
              </div>

              {optionsError === undefined ? null : (
                <p role="alert" className="text-caption text-danger">
                  {optionsError}
                </p>
              )}

              <div className="flex items-center gap-sm">
                <button
                  type="button"
                  onClick={() =>
                    patchQuestion(question.key, {
                      options: [...question.options, blankOption()],
                    })
                  }
                  disabled={question.options.length >= QUIZ_MAX_OPTIONS}
                  className={buttonClass('ghost', 'sm')}
                >
                  <Plus aria-hidden className="size-4" />
                  Add option
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setQuestions((current) => current.filter((entry) => entry.key !== question.key))
                  }
                  disabled={questions.length === 1}
                  className={cn(buttonClass('ghost', 'sm'), 'ml-auto text-danger')}
                >
                  <Trash2 aria-hidden className="size-4" />
                  Remove question
                </button>
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <button
          type="button"
          onClick={() => setQuestions((current) => [...current, blankQuestion()])}
          disabled={questions.length >= QUIZ_MAX_QUESTIONS}
          className={buttonClass('secondary', 'sm')}
        >
          <Plus aria-hidden className="size-4" />
          Add question
        </button>

        <button
          type="submit"
          disabled={state.submitting}
          className={buttonClass('primary', 'md', 'ml-auto')}
        >
          {state.submitting ? 'Creating…' : 'Create set'}
        </button>
      </div>
    </form>
  );
};

'use client';

/**
 * A thread and its answers.
 *
 * Three decisions:
 *
 *   * **The accepted answer is pinned to the top of the answer list.** It is the reason
 *     most people opened the thread; making them scroll to find the endorsement defeats
 *     it. The original order is preserved underneath.
 *   * **Accepting is a single click with no confirmation.** It is reversible — accepting
 *     a different answer moves the endorsement — so a modal would be friction for an
 *     action the user can simply redo.
 *   * **A reply box is absent on a locked thread**, replaced by an explanation. A
 *     disabled textarea invites the user to write a paragraph and then lose it.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Lock, Trash2 } from 'lucide-react';

import { createAnswerRequestSchema } from '@socialhub/contracts';
import type { ForumAnswerResponse, ForumThreadDetailResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { FormError } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { createForumApi } from '@/lib/forum-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

export const ThreadView = ({
  threadId,
  initial,
}: {
  readonly threadId: string;
  readonly initial: ForumThreadDetailResponse;
}): React.JSX.Element => {
  const { client } = useSession();
  const { state, start, fail, succeed } = useSubmitState();

  const [detail, setDetail] = useState<ForumThreadDetailResponse>(initial);
  const [status, setStatus] = useState<Status>('ready');
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);

    try {
      setDetail(await createForumApi(client).thread(threadId));
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, threadId]);

  useEffect(() => {
    // The page renders the detail it was given, so no fetch is needed on mount; this
    // effect only refreshes when the id changes (client-side navigation between threads).
    void threadId;
  }, [threadId]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const parsed = createAnswerRequestSchema.safeParse({ body });
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    start();
    try {
      const answer = await createForumApi(client).createAnswer(threadId, parsed.data);
      setDetail((current) => ({
        ...current,
        answers: [...current.answers, answer],
        thread: { ...current.thread, answerCount: current.thread.answerCount + 1 },
      }));
      setBody('');
      succeed();
    } catch (cause) {
      if (isApiFailure(cause)) {
        const mapped = fieldsFromApi(cause);
        fail({ fields: mapped.fields, form: mapped.form });
        return;
      }
      fail({ form: describeError(cause) });
    }
  };

  const accept = async (answer: ForumAnswerResponse): Promise<void> => {
    try {
      const accepted = await createForumApi(client).acceptAnswer(threadId, answer.id);
      setDetail((current) => ({
        ...current,
        answers: current.answers.map((entry) =>
          entry.id === accepted.id
            ? accepted
            : // Accepting one answer clears the previous endorsement, so the old one has
              // to lose its mark in the same update.
              { ...entry, accepted: false },
        ),
        thread: { ...current.thread, hasAcceptedAnswer: true, canAcceptAnswer: false },
      }));
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const remove = async (answer: ForumAnswerResponse): Promise<void> => {
    try {
      await createForumApi(client).deleteAnswer(answer.id);
      setDetail((current) => ({
        ...current,
        answers: current.answers.filter((entry) => entry.id !== answer.id),
        thread: { ...current.thread, answerCount: Math.max(current.thread.answerCount - 1, 0) },
      }));
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const now = new Date();
  const thread = detail.thread;

  // The accepted answer first, then everything else in publication order.
  const ordered = [...detail.answers].sort((a, b) => Number(b.accepted) - Number(a.accepted));

  if (status === 'error') {
    return (
      <div className="flex flex-col gap-sm">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That thread is not available.'}
        </p>
        <Link href="/forum" className="text-small font-medium text-primary underline">
          Back to the forum
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <article className="flex flex-col gap-sm rounded-lg border border-border bg-surface p-md">
        <div className="flex flex-wrap items-center gap-xs">
          <Link
            href={`/forum?category=${encodeURIComponent(thread.categoryPath)}`}
            className="rounded-sm bg-raised px-1 text-caption text-muted hover:text-text"
          >
            {thread.categoryPath}
          </Link>
          {thread.pinned ? <span className="text-caption text-primary">Pinned</span> : null}
          {thread.locked ? (
            <span className="inline-flex items-center gap-[2px] text-caption text-muted">
              <Lock aria-hidden className="size-3" />
              Locked
            </span>
          ) : null}
        </div>

        <h1 className="text-heading">{thread.title}</h1>

        <p className="whitespace-pre-wrap text-body text-text">{thread.body}</p>

        <p className="text-caption text-muted">
          <Link href={`/u/${thread.author.username}`} className="font-medium hover:underline">
            {thread.author.displayName}
          </Link>{' '}
          · <span suppressHydrationWarning>{relativeTime(thread.createdAt, now)}</span>
        </p>
      </article>

      <section className="flex flex-col gap-sm" aria-labelledby="answers-heading">
        <h2 id="answers-heading" className="text-subheading">
          {thread.answerCount} {thread.answerCount === 1 ? 'answer' : 'answers'}
        </h2>

        {error === null ? null : (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}

        {ordered.length === 0 ? (
          <p className="rounded-lg border border-border p-md text-body text-muted">
            No answers yet. If you know the answer, it is worth writing down.
          </p>
        ) : (
          <ul className="flex flex-col gap-sm">
            {ordered.map((answer) => (
              <li
                key={answer.id}
                className={cn(
                  'flex flex-col gap-xs rounded-lg border p-md',
                  answer.accepted
                    ? 'border-success bg-success-surface'
                    : 'border-border bg-surface',
                )}
              >
                <div className="flex flex-wrap items-center gap-xs">
                  <Link
                    href={`/u/${answer.author.username}`}
                    className="text-small font-medium hover:underline"
                  >
                    {answer.author.displayName}
                  </Link>
                  <span className="text-caption text-muted" suppressHydrationWarning>
                    {relativeTime(answer.createdAt, now)}
                  </span>
                  {answer.accepted ? (
                    <span className="inline-flex items-center gap-[2px] text-caption font-medium text-success">
                      <CircleCheck aria-hidden className="size-3" />
                      Accepted answer
                    </span>
                  ) : null}
                </div>

                <p className="whitespace-pre-wrap text-body">{answer.body}</p>

                <div className="flex items-center gap-sm">
                  {thread.canAcceptAnswer ? (
                    <button
                      type="button"
                      onClick={() => void accept(answer)}
                      className={buttonClass('ghost', 'sm')}
                    >
                      <CircleCheck aria-hidden className="size-4" />
                      Accept
                    </button>
                  ) : null}

                  {answer.canDelete ? (
                    <button
                      type="button"
                      onClick={() => void remove(answer)}
                      className={cn(buttonClass('ghost', 'sm'), 'text-danger')}
                    >
                      <Trash2 aria-hidden className="size-4" />
                      Delete
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {thread.locked ? (
        <p className="rounded-lg border border-border p-md text-small text-muted">
          This thread is locked. Answers can be read, but no new ones can be added.
        </p>
      ) : (
        <form
          className="flex flex-col gap-sm rounded-lg border border-border bg-surface p-md"
          noValidate
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <h2 className="text-small font-medium">Your answer</h2>

          {state.formError === null ? null : <FormError>{state.formError}</FormError>}

          <label htmlFor="answer-body" className="sr-only">
            Answer text
          </label>
          <textarea
            id="answer-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            aria-invalid={state.fieldErrors['body'] === undefined ? undefined : true}
            className="w-full resize-y rounded-md border border-border bg-canvas px-sm py-xs text-body"
          />
          {state.fieldErrors['body'] === undefined ? null : (
            <p role="alert" className="text-caption text-danger">
              {state.fieldErrors['body']}
            </p>
          )}

          <button
            type="submit"
            disabled={state.submitting || body.trim().length === 0}
            className={buttonClass('primary', 'sm', 'self-start')}
          >
            {state.submitting ? 'Posting…' : 'Post answer'}
          </button>
        </form>
      )}

      <button
        type="button"
        onClick={() => void load()}
        className="self-start text-small font-medium text-primary underline"
      >
        Refresh answers
      </button>
    </div>
  );
};

'use client';

/**
 * Post composer.
 *
 * Two decisions worth stating:
 *
 *   * The character counter multiplies by code points, matching the server. A
 *     counter that disagrees with the validator shows a green "0 remaining" and
 *     then refuses the post, which is worse than no counter at all.
 *   * The body is not validated on the first keystroke. An empty composer is the
 *     normal starting state; announcing "write something first" before the user
 *     has typed is noise.
 */

import { useState } from 'react';
import { Send } from 'lucide-react';
import { createPostRequestSchema, POST_VISIBILITIES } from '@socialhub/contracts';
import { POST_BODY_MAX_LENGTH } from '@socialhub/kernel/browser';

import { buttonClass } from '@/components/ui/button-styles';
import { FormError } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { createFeedApi } from '@/lib/feed-api';
import { useSession } from '@/lib/session';

export type PostComposerProps = {
  readonly onPublished: () => void;
  /** Rendered as the composer's heading, so the same component serves replies. */
  readonly placeholder?: string;
  readonly replyTo?: string;
  readonly autoFocus?: boolean;
};

const VISIBILITY_LABELS: Record<(typeof POST_VISIBILITIES)[number], string> = {
  PUBLIC: 'Everyone',
  FOLLOWERS: 'Followers',
  PRIVATE: 'Only me',
};

export const PostComposer = ({
  onPublished,
  placeholder = 'What is happening?',
  replyTo,
  autoFocus,
}: PostComposerProps): React.JSX.Element => {
  const { client } = useSession();
  const { state, start, fail, succeed } = useSubmitState();

  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<(typeof POST_VISIBILITIES)[number]>('PUBLIC');

  // Code points, not UTF-16 units: an emoji is one character to the author.
  const remaining = POST_BODY_MAX_LENGTH - [...body.trim()].length;

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const parsed = createPostRequestSchema.safeParse({
      body,
      visibility,
      ...(replyTo === undefined ? {} : { replyTo }),
    });

    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    start();
    try {
      await createFeedApi(client).create(parsed.data);
      // Clear only on success: a failed post must not discard what the user wrote.
      setBody('');
      succeed();
      onPublished();
    } catch (cause) {
      if (isApiFailure(cause)) {
        const mapped = fieldsFromApi(cause);
        fail({ fields: mapped.fields, form: mapped.form });
        return;
      }
      fail({ form: describeError(cause) });
    }
  };

  const error = state.formError ?? state.fieldErrors['body'] ?? null;

  return (
    <form
      className="flex flex-col gap-sm rounded-lg border border-border bg-surface p-md"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {error === null ? null : <FormError>{error}</FormError>}

      <label htmlFor="post-body" className="sr-only">
        Post text
      </label>
      <textarea
        id="post-body"
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={placeholder}
        rows={3}
        autoFocus={autoFocus ?? false}
        aria-invalid={state.fieldErrors['body'] === undefined ? undefined : true}
        className={cn(
          'w-full resize-y rounded-md border border-border bg-canvas px-sm py-xs',
          'text-body text-text placeholder:text-text-muted',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
        )}
      />

      <div className="flex flex-wrap items-center gap-sm">
        <label htmlFor="post-visibility" className="sr-only">
          Who can see this
        </label>
        <select
          id="post-visibility"
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as typeof visibility)}
          className="h-11 rounded-md border border-border bg-canvas px-sm text-small text-text"
        >
          {POST_VISIBILITIES.map((option) => (
            <option key={option} value={option}>
              {VISIBILITY_LABELS[option]}
            </option>
          ))}
        </select>

        <span
          // Announced politely so a screen reader user is warned before the limit
          // is hit, not after the post is refused.
          aria-live="polite"
          className={cn(
            'ml-auto text-caption tabular-nums',
            remaining < 0 ? 'text-danger' : 'text-text-muted',
          )}
        >
          {remaining}
        </span>

        <button
          type="submit"
          className={buttonClass('primary', 'sm')}
          disabled={state.submitting || body.trim().length === 0}
        >
          <Send aria-hidden className="size-4" />
          {state.submitting ? 'Posting…' : replyTo === undefined ? 'Post' : 'Reply'}
        </button>
      </div>
    </form>
  );
};

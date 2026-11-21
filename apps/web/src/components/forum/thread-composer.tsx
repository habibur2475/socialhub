'use client';

/**
 * Starting a thread.
 *
 * The category list comes from the server rather than from a constant, so a category
 * added by a moderator appears without a client deploy — and a hard-coded list would
 * eventually submit an id that no longer exists.
 *
 * Validation is the shared schema, so the title window in the form is literally the one
 * the API enforces.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { createThreadRequestSchema } from '@socialhub/contracts';
import type { ForumCategoryResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, FormError, Input } from '@/components/ui/field';
import { describeError, fieldsFromApi, fieldsFromZod, useSubmitState } from '@/lib/form';
import { isApiFailure } from '@/lib/api-client';
import { createForumApi } from '@/lib/forum-api';
import { useSession } from '@/lib/session';

export const ThreadComposer = (): React.JSX.Element => {
  const { client } = useSession();
  const router = useRouter();
  const { state, start, fail } = useSubmitState();

  const [categories, setCategories] = useState<readonly ForumCategoryResponse[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    let cancelled = false;

    void createForumApi(client)
      .categories()
      .then((page) => {
        if (cancelled) return;
        setCategories(page.items);
        // Preselect the first category: an empty select that the user must fill in is
        // a needless step when there is usually only one obvious place to post.
        setCategoryId(page.items[0]?.id ?? '');
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [client]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const parsed = createThreadRequestSchema.safeParse({ categoryId, title, body });
    if (!parsed.success) {
      fail({ fields: fieldsFromZod(parsed.error) });
      return;
    }

    start();
    try {
      const created = await createForumApi(client).createThread(parsed.data);
      router.push(`/forum/threads/${created.id}`);
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
      className="flex flex-col gap-sm rounded-lg border border-border bg-surface p-md"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {state.formError === null ? null : <FormError>{state.formError}</FormError>}

      <Field label="Category" htmlFor="thread-category" error={state.fieldErrors['categoryId']}>
        <select
          id="thread-category"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="h-11 rounded-md border border-border bg-canvas px-sm text-small text-text"
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.path}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Title"
        htmlFor="thread-title"
        required
        hint="A question gets answered; a statement usually does not."
        error={state.fieldErrors['title']}
      >
        <Input
          id="thread-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={160}
        />
      </Field>

      <Field label="Body" htmlFor="thread-body" required error={state.fieldErrors['body']}>
        <textarea
          id="thread-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={8}
          className="w-full resize-y rounded-md border border-border bg-canvas px-sm py-xs text-body"
        />
      </Field>

      <button
        type="submit"
        disabled={state.submitting || categories.length === 0}
        className={buttonClass('primary', 'sm', 'self-start')}
      >
        {state.submitting ? 'Posting…' : 'Post thread'}
      </button>
    </form>
  );
};

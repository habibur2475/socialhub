'use client';

/**
 * The composer.
 *
 * The reading time, the excerpt and the slug are shown **while typing**, from the same
 * kernel functions the server runs (`readingMinutes`, `excerptOf`, `slugify`). Importing
 * them rather than re-implementing them is the point: a preview that estimates differently
 * from the stored article is a preview that lies, and the fix when the rules change is one
 * file instead of two.
 *
 * The slug field starts empty and shows a provisional slug derived from the title. Leaving
 * it empty means "derive it for me"; typing into it means "this is the URL", and the server
 * answers a collision with a `409` rather than silently suffixing it.
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowLeft, Eye } from 'lucide-react';

import {
  ARTICLE_BODY_MAX_LENGTH,
  ARTICLE_TAGS_MAX,
  ARTICLE_TITLE_MAX_LENGTH,
  excerptOf,
  hasUnbalancedFence,
  readingMinutes,
  slugify,
} from '@socialhub/kernel/browser';

import { ArticleBody } from '@/components/blog/article-body';
import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createBlogApi } from '@/lib/blog-api';
import { useSession } from '@/lib/session';

export const ArticleComposer = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [slug, setSlug] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provisionalSlug = useMemo(() => slugify(title), [title]);
  const minutes = useMemo(() => (body.trim() === '' ? 0 : readingMinutes(body)), [body]);
  const excerpt = useMemo(() => (body.trim() === '' ? '' : excerptOf(body)), [body]);
  const unbalanced = useMemo(() => hasUnbalancedFence(body), [body]);

  const tagList = tags
    .split(/[\s,]+/u)
    .map((tag) => tag.replace(/^#/u, '').trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag !== '--');

  const canSubmit =
    sessionStatus === 'authenticated' &&
    title.trim().length >= 3 &&
    body.trim().length > 0 &&
    !unbalanced &&
    !busy;

  const submit = async (event: React.FormEvent, thenPublish: boolean): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError(null);

    try {
      const api = createBlogApi(client);
      const created = await api.create({
        title: title.trim(),
        body,
        ...(slug.trim() === '' ? {} : { slug: slug.trim() }),
        tags: tagList,
      });

      if (thenPublish) {
        // Publishing is a second request on purpose: a create that also published would
        // be one endpoint with two failure modes, and a failed publish would lose the
        // article that was just written.
        await api.publish(created.id, { status: 'PUBLISHED' });
      }

      router.push(`/blog/${created.slug}`);
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-md">
      <header className="flex items-center gap-sm">
        <button
          type="button"
          onClick={() => router.push('/blog?mine=true')}
          aria-label="Back to your articles"
          className="rounded-full p-xs text-muted transition-colors hover:bg-raised"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </button>
        <h1 className="text-heading">New article</h1>
        <button
          type="button"
          onClick={() => setPreview((current) => !current)}
          aria-pressed={preview}
          className={cn(buttonClass('secondary', 'sm'), 'ml-auto')}
        >
          <Eye aria-hidden className="size-4" />
          {preview ? 'Write' : 'Preview'}
        </button>
      </header>

      <form className="flex flex-col gap-md" onSubmit={(event) => void submit(event, false)}>
        <div className="flex flex-col gap-xs">
          <label htmlFor="article-title" className="text-small font-medium">
            Title
          </label>
          <input
            id="article-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={ARTICLE_TITLE_MAX_LENGTH}
            placeholder="What is this article about?"
            className="h-11 rounded-lg border border-border bg-surface px-sm text-body outline-none focus:border-primary"
          />
        </div>

        <div className="flex flex-col gap-xs">
          <div className="flex items-baseline justify-between gap-sm">
            <label htmlFor="article-body" className="text-small font-medium">
              Body
            </label>
            <span className="text-caption text-muted">
              {minutes === 0 ? '—' : `${minutes} min read`}
            </span>
          </div>

          {preview ? (
            <div className="min-h-[240px] rounded-lg border border-border p-md">
              {body.trim() === '' ? (
                <p className="text-body text-muted">Nothing to preview yet.</p>
              ) : (
                <ArticleBody body={body} />
              )}
            </div>
          ) : (
            <textarea
              id="article-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={ARTICLE_BODY_MAX_LENGTH}
              rows={16}
              placeholder={
                '## A heading\n\nMarkdown: headings, lists, quotes, `code` and **bold**.'
              }
              aria-describedby="article-body-hint"
              className="resize-y rounded-lg border border-border bg-surface p-sm font-mono text-small leading-relaxed outline-none focus:border-primary"
            />
          )}

          <p
            id="article-body-hint"
            className={cn('text-caption', unbalanced ? 'text-danger' : 'text-muted')}
          >
            {unbalanced
              ? 'A code block is not closed — add the closing ```'
              : `Markdown, no raw HTML. ${body.length.toLocaleString()} / ${ARTICLE_BODY_MAX_LENGTH.toLocaleString()} characters.`}
          </p>
        </div>

        <div className="grid gap-md sm:grid-cols-2">
          <div className="flex flex-col gap-xs">
            <label htmlFor="article-slug" className="text-small font-medium">
              URL
            </label>
            <input
              id="article-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder={provisionalSlug === '' ? 'article-…' : provisionalSlug}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="article-slug-hint"
              className="h-11 rounded-lg border border-border bg-surface px-sm font-mono text-small outline-none focus:border-primary"
            />
            <p id="article-slug-hint" className="text-caption text-muted">
              /blog/{slug.trim() === '' ? provisionalSlug || '…' : slug.trim()}
            </p>
          </div>

          <div className="flex flex-col gap-xs">
            <label htmlFor="article-tags" className="text-small font-medium">
              Tags
            </label>
            <input
              id="article-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="postgresql, typescript"
              spellCheck={false}
              className="h-11 rounded-lg border border-border bg-surface px-sm text-small outline-none focus:border-primary"
            />
            <p className="text-caption text-muted">
              {tagList.length > ARTICLE_TAGS_MAX
                ? `Only the first ${ARTICLE_TAGS_MAX} are kept`
                : 'Lowercase words; commas separate them.'}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-xs">
          <span className="text-caption text-muted">Excerpt, derived from the body</span>
          <p className="rounded-lg bg-raised p-sm text-small text-muted">
            {excerpt === '' ? 'The first few lines of the body become the excerpt.' : excerpt}
          </p>
        </div>

        {error !== null ? (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-sm">
          <button type="submit" disabled={!canSubmit} className={buttonClass('secondary', 'md')}>
            {busy ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={(event) => void submit(event, true)}
            className={buttonClass('primary', 'md')}
          >
            Publish
          </button>
          <span className="text-caption text-muted">A draft is private until you publish it.</span>
        </div>
      </form>
    </div>
  );
};

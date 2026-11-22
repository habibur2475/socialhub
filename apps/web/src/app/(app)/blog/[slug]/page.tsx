/**
 * One article, by slug.
 *
 * Keyed on the slug so navigating between two articles remounts the view: the publishing
 * controls and the schedule field must not carry over from another article.
 */

'use client';

import { useParams } from 'next/navigation';

import { ArticleView } from '@/components/blog/article-view';

export default function ArticlePage(): React.JSX.Element {
  const params = useParams<{ slug: string }>();

  return (
    <div className="mx-auto max-w-[720px]">
      <ArticleView key={params.slug} idOrSlug={params.slug} />
    </div>
  );
}

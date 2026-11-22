/**
 * The blog index.
 *
 * `useSearchParams` needs a Suspense boundary in the App Router, or the page is forced
 * dynamic and Next warns at build time. The boundary wraps only the list, so the heading
 * paints immediately.
 */

'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { Plus } from 'lucide-react';

import { ArticleList } from '@/components/blog/article-list';
import { buttonClass } from '@/components/ui/button-styles';

export default function BlogPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-wrap items-end justify-between gap-sm">
        <div className="flex flex-col gap-xs">
          <h1 className="text-heading">Blog</h1>
          <p className="text-body text-muted">
            Long-form writing. An article is a draft until you publish it, and a scheduled one
            becomes readable the moment it is due.
          </p>
        </div>
        <Link href="/blog/new" className={buttonClass('primary', 'sm')}>
          <Plus aria-hidden className="size-4" />
          Write
        </Link>
      </header>

      <Suspense
        fallback={
          <div className="flex flex-col gap-sm" aria-busy>
            <div className="skeleton h-9 w-full" />
            <div className="skeleton h-24 w-full" />
          </div>
        }
      >
        <ArticleList />
      </Suspense>
    </div>
  );
}

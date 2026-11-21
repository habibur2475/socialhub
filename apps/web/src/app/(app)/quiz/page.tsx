/**
 * Quiz library.
 *
 * A server component would need the access token, which only exists in memory in the
 * browser — so the page is a thin client wrapper around the list.
 */

'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';

import { QuizList } from '@/components/quiz/quiz-list';
import { buttonClass } from '@/components/ui/button-styles';

export default function QuizPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-wrap items-end justify-between gap-sm">
        <div className="flex flex-col gap-xs">
          <h1 className="text-heading">Quiz</h1>
          <p className="text-body text-muted">
            Practice sets with instant, explainable grading. Timed sets are available too.
          </p>
        </div>
        <Link href="/quiz/new" className={buttonClass('primary', 'sm')}>
          <Plus aria-hidden className="size-4" />
          New set
        </Link>
      </header>

      <QuizList />
    </div>
  );
}

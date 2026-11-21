/**
 * Creating a quiz set.
 *
 * The composer is a client component (it holds a local draft and needs the in-memory
 * token); this page supplies the heading and the width.
 */

'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { QuizComposer } from '@/components/quiz/quiz-composer';

export default function NewQuizPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <Link
          href="/quiz"
          className="inline-flex items-center gap-xs text-small text-muted hover:text-text"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Quiz
        </Link>
        <h1 className="text-heading">New set</h1>
        <p className="text-body text-muted">
          Every question needs at least two options and exactly the answer key you choose.
        </p>
      </header>

      <QuizComposer />
    </div>
  );
}

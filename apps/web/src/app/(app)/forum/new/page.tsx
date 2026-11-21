'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { ThreadComposer } from '@/components/forum/thread-composer';

export default function NewThreadPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <Link
          href="/forum"
          className="inline-flex items-center gap-xs text-small text-muted hover:text-text"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Forum
        </Link>
        <h1 className="text-heading">New thread</h1>
        <p className="text-body text-muted">
          Describe the problem and what you have already tried. That is what makes an answer
          possible.
        </p>
      </header>

      <ThreadComposer />
    </div>
  );
}

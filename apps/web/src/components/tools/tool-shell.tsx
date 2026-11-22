'use client';

/**
 * The frame every tool sits in.
 *
 * A tool is a page with a heading, one sentence of explanation, and a note about where the
 * data goes. That last part is not decoration: "this never leaves your device" is the most
 * important thing several of these tools can tell a person, and a promise made only in a
 * privacy policy is a promise nobody reads.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';

export type DataHandling = 'local' | 'server';

const HANDLING: Record<DataHandling, { label: string; className: string }> = {
  local: {
    label: 'Everything stays in this browser — nothing is uploaded or saved to an account.',
    className: 'border-success/30 bg-success/10 text-success',
  },
  server: {
    label: 'Saved to your SocialHub account, visible only to you.',
    className: 'border-primary/30 bg-primary/10 text-primary',
  },
};

export type ToolShellProps = {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly description: string;
  readonly handling: DataHandling;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
};

export const ToolShell = ({
  title,
  icon: Icon,
  description,
  handling,
  children,
  aside,
}: ToolShellProps): React.JSX.Element => {
  const note = HANDLING[handling];

  return (
    <div className="flex flex-col gap-lg">
      <header className="flex flex-col gap-sm">
        <Link
          href="/tools"
          className="flex w-fit items-center gap-xs text-small text-muted transition-colors hover:text-text"
        >
          <ArrowLeft aria-hidden className="size-4" />
          All tools
        </Link>

        <div className="flex items-center gap-sm">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden className="size-5" />
          </span>
          <h1 className="text-heading">{title}</h1>
        </div>

        <p className="max-w-[60ch] text-body text-muted">{description}</p>

        <p className={cn('w-fit rounded-md border px-sm py-xs text-caption', note.className)}>
          {note.label}
        </p>
      </header>

      <div className={aside === undefined ? '' : 'grid gap-lg lg:grid-cols-[1fr_320px]'}>
        <div className="min-w-0">{children}</div>
        {aside === undefined ? null : <div className="flex flex-col gap-md">{aside}</div>}
      </div>
    </div>
  );
};

/** A labelled control shared by every tool, so the forms cannot drift apart. */
export const ToolField = ({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): React.JSX.Element => (
  <div className="flex flex-col gap-xs">
    <label htmlFor={htmlFor} className="text-small font-medium">
      {label}
    </label>
    {children}
    {hint === undefined ? null : <p className="text-caption text-muted">{hint}</p>}
  </div>
);

export const toolInputClass =
  'h-11 w-full rounded-lg border border-border bg-surface px-sm text-body outline-none transition-colors focus:border-primary';

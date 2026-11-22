/**
 * The tools index.
 *
 * Server-rendered: there is nothing to fetch, so the catalogue paints with the page and the
 * only client code a visitor downloads is the shell around it.
 */

import Link from 'next/link';
import { Wrench } from 'lucide-react';

import { TOOLS } from '@/components/tools/tool-catalogue';

export const metadata = { title: 'Tools — SocialHub' };

export default function ToolsPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <div className="flex items-center gap-sm">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Wrench aria-hidden className="size-5" />
          </span>
          <h1 className="text-heading">Tools</h1>
        </div>
        <p className="max-w-[60ch] text-body text-muted">
          Seven small utilities. Six of them never leave your browser — no upload, no account, no
          copy on a server. Notes are the exception, because a note you cannot open on your phone is
          not a note.
        </p>
      </header>

      <ul className="grid gap-sm sm:grid-cols-2">
        {TOOLS.map((tool) => (
          <li key={tool.key}>
            <Link
              href={tool.href}
              className="flex h-full flex-col gap-xs rounded-xl border border-border p-md transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <span className="flex items-center gap-sm">
                <span className="flex size-9 items-center justify-center rounded-lg bg-raised text-foreground">
                  <tool.icon aria-hidden className="size-4" />
                </span>
                <span className="flex flex-col">
                  <span className="text-body font-medium">{tool.label}</span>
                  {tool.bengali === undefined ? null : (
                    <span className="text-caption text-muted">{tool.bengali}</span>
                  )}
                </span>
                <span className="ml-auto rounded-full bg-raised px-[6px] py-[1px] text-caption text-muted">
                  {tool.storage === 'device' ? 'on this device' : 'in your account'}
                </span>
              </span>
              <span className="text-small text-muted">{tool.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

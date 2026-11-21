/**
 * Authentication layout.
 *
 * A centred single column, capped at 420px. Wider than that and the input fields
 * become uncomfortably long; narrower and a long email wraps inside the field.
 *
 * There is no site header here on purpose: every extra chrome element on a login
 * screen is an exit. The only navigation is a link back to the marketing page.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

export default function AuthLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-header items-center px-md">
        <Link href="/" className="flex items-center gap-xs">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-md bg-primary text-small font-bold text-primary-contrast"
          >
            SH
          </span>
          <span className="text-subheading font-bold tracking-tight">SocialHub</span>
        </Link>
      </header>

      <main
        id="main"
        className="flex flex-1 items-start justify-center px-md py-xl sm:items-center"
      >
        <div className="w-full max-w-[420px]">{children}</div>
      </main>

      <footer className="px-md py-lg text-center text-caption text-muted">
        <span>© {new Date().getFullYear()} SocialHub</span>
      </footer>
    </div>
  );
}

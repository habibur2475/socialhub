/**
 * Marketing layout.
 *
 * A minimal header and no sidebar: these pages are read, not operated. The shell
 * is reserved for signed-in surfaces, where persistent navigation earns its space.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { buttonClass } from '@/components/ui/button-styles';
import { ThemeToggle } from '@/components/layout/theme-toggle';

export default function MarketingLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-md focus:top-md focus:z-toast focus:rounded-md focus:bg-primary focus:px-md focus:py-xs focus:text-primary-contrast"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-header border-b border-border bg-surface/95 backdrop-blur">
        <div className="container-shell flex h-header items-center gap-sm px-md">
          <Link href="/" className="flex items-center gap-xs">
            <span
              aria-hidden
              className="grid size-8 place-items-center rounded-md bg-primary text-small font-bold text-primary-contrast"
            >
              SH
            </span>
            <span className="text-subheading font-bold tracking-tight">SocialHub</span>
          </Link>

          <nav aria-label="Primary" className="ml-auto hidden items-center gap-md sm:flex">
            <a href="#features-heading" className="text-small text-muted hover:text-text">
              Features
            </a>
            <a href="#about-heading" className="text-small text-muted hover:text-text">
              About
            </a>
            <a href="#contact-heading" className="text-small text-muted hover:text-text">
              Contact
            </a>
          </nav>

          <div className="ml-auto flex items-center gap-xs sm:ml-sm">
            <ThemeToggle className="hidden md:inline-flex" />
            <Link href="/login" className={buttonClass('ghost', 'sm')}>
              Sign in
            </Link>
            <Link href="/register" className={buttonClass('primary', 'sm')}>
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}

'use client';

/**
 * The application shell.
 *
 * Structure, and the rules each region obeys:
 *
 *   Header        fixed, 64px, holds the identity and the global actions.
 *   Sidebar       desktop only, collapsible; hidden below `lg` because a
 *                 persistent 260px rail on a 390px phone leaves 130px of content.
 *   MainContent   the only scroll container. One scroll region means pull-to-
 *                 refresh and scroll restoration behave predictably.
 *   BottomNav     mobile only, five items maximum, safe-area aware.
 *   SystemLayer   toasts and other portalled layers, one stacking context.
 *
 * The skip link is the first focusable element in the document. It is the single
 * cheapest accessibility win available and it is routinely omitted: without it, a
 * keyboard user must tab through the entire navigation on every page.
 *
 * Layout uses `min-h-dvh` rather than `100vh` so mobile browser chrome collapsing
 * does not clip the bottom navigation — the classic "button under the toolbar" bug.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { cn } from '@/lib/cn';
import { MOBILE_PRIMARY_ITEMS, NAV_ITEMS } from './navigation';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

const SIDEBAR_STORAGE_KEY = 'socialhub.sidebar';

export const AppShell = ({ children }: { readonly children: ReactNode }): React.JSX.Element => {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Persisted so a deliberate collapse survives navigation. Read in an effect,
  // not during render, because `localStorage` does not exist on the server and a
  // mismatch here is a hydration error.
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed');
  }, []);

  // Any navigation closes the mobile drawer; leaving it open over new content is
  // disorienting and leaves a hidden focus trap active.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const toggleSidebar = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? 'collapsed' : 'expanded');
  };

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-md focus:top-md focus:z-toast focus:rounded-md focus:bg-primary focus:px-md focus:py-xs focus:text-primary-contrast"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-header flex h-header items-center gap-sm border-b border-border bg-surface/95 px-md backdrop-blur">
        <button
          type="button"
          onClick={() => setMobileNavOpen((open) => !open)}
          aria-expanded={mobileNavOpen}
          aria-controls="mobile-nav"
          className="inline-flex size-11 items-center justify-center rounded-md text-text lg:hidden"
        >
          <Menu aria-hidden className="size-5" />
          <span className="sr-only">Open navigation</span>
        </button>

        <Link href="/" className="flex items-center gap-xs">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-md bg-primary text-small font-bold text-primary-contrast"
          >
            SH
          </span>
          <span className="text-subheading font-bold tracking-tight">SocialHub</span>
        </Link>

        <div className="ml-auto flex items-center gap-xs">
          <ThemeToggle className="hidden sm:inline-flex" />
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1">
        <aside
          className={cn(
            'sticky top-header hidden h-[calc(100dvh-var(--header-height,64px))] shrink-0 border-r border-border bg-surface lg:block',
            collapsed ? 'w-[72px]' : 'w-[260px]',
            'transition-[width] duration-base ease-standard',
          )}
        >
          <nav aria-label="Primary" className="flex flex-col gap-[2px] p-xs">
            {NAV_ITEMS.map(({ key, label, href, icon: Icon, status }) => {
              const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
              return (
                <Link
                  key={key}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? label : undefined}
                  className={cn(
                    'flex h-11 items-center gap-sm rounded-md px-sm text-small transition-colors duration-fast',
                    active
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted hover:bg-raised hover:text-text',
                    collapsed && 'justify-center px-0',
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  {collapsed ? (
                    <span className="sr-only">{label}</span>
                  ) : (
                    <>
                      <span>{label}</span>
                      {status === 'planned' ? (
                        <span className="ml-auto rounded-sm bg-border/60 px-1 text-caption text-muted">
                          soon
                        </span>
                      ) : null}
                    </>
                  )}
                </Link>
              );
            })}
          </nav>

          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'absolute bottom-md inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-text',
              collapsed ? 'left-1/2 -translate-x-1/2' : 'right-sm',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden className="size-4" />
            ) : (
              <PanelLeftClose aria-hidden className="size-4" />
            )}
          </button>
        </aside>

        {mobileNavOpen ? (
          <div className="fixed inset-0 top-header z-overlay bg-canvas/80 backdrop-blur-sm lg:hidden">
            <nav
              id="mobile-nav"
              aria-label="Primary"
              className="flex flex-col gap-[2px] border-b border-border bg-surface p-sm"
            >
              {NAV_ITEMS.map(({ key, label, href, icon: Icon }) => (
                <Link
                  key={key}
                  href={href}
                  className="flex h-11 items-center gap-sm rounded-md px-sm text-body text-text hover:bg-raised"
                >
                  <Icon aria-hidden className="size-4" />
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        ) : null}

        <main
          id="main"
          // Bottom padding clears the mobile bar; without it the last row of any
          // list is permanently unreachable behind the navigation.
          className="min-w-0 flex-1 px-md pb-[calc(64px+env(safe-area-inset-bottom)+16px)] pt-lg lg:px-xl lg:pb-xxl"
        >
          {children}
        </main>
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-sticky flex h-bottomNav items-center border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        {MOBILE_PRIMARY_ITEMS.map(({ key, label, href, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={key}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-[2px] text-caption',
                active ? 'text-primary' : 'text-muted',
              )}
            >
              <Icon aria-hidden className="size-5" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Portalled overlays mount here so they share one stacking context. */}
      <div id="system-layer" />
    </div>
  );
};

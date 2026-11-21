'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LogOut, User } from 'lucide-react';

import { useSession } from '@/lib/session';
import { Button, buttonClass } from '@/components/ui/button';

export const UserMenu = (): React.JSX.Element => {
  const { status, session, signOut } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // A popover must close on outside click *and* on Escape. Escape is the one
  // keyboard users rely on, and `<details>`-style menus routinely omit it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (container.current !== null && !container.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Nothing is shown while restoring: rendering a "Sign in" button and swapping it
  // for an avatar a moment later is the flash-of-wrong-state we are avoiding.
  if (status === 'restoring') {
    return <div className="size-11" aria-hidden />;
  }

  if (status === 'anonymous' || session === null) {
    return (
      <Link href="/login" className={buttonClass('primary', 'sm')}>
        Sign in
      </Link>
    );
  }

  const initials = session.user.id.slice(0, 2).toUpperCase();

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex size-11 items-center justify-center rounded-full bg-primary/10 text-small font-semibold text-primary"
      >
        {initials}
        <span className="sr-only">Account menu</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+8px)] z-popover w-56 rounded-md border border-border bg-raised p-xs shadow-lg"
        >
          <div className="border-b border-border px-sm pb-xs">
            <p className="text-caption text-muted">{session.user.accountType}</p>
            <p className="truncate text-small font-medium">{session.user.id}</p>
          </div>

          <Link
            href="/settings/profile"
            role="menuitem"
            className="flex h-11 items-center gap-sm rounded-sm px-sm text-small hover:bg-surface"
          >
            <User aria-hidden className="size-4" /> Edit profile
          </Link>

          <Button
            variant="ghost"
            size="sm"
            fullWidth
            className="justify-start"
            leadingIcon={<LogOut aria-hidden className="size-4" />}
            onClick={() => {
              void signOut('current').then(() => {
                router.replace('/login');
              });
            }}
          >
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
};

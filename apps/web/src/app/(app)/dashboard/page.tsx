'use client';

import { useSession } from '@/lib/session';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { NAV_ITEMS } from '@/components/layout/navigation';

/**
 * Signed-in landing page.
 *
 * Shows the account's real identity and permission list — not a hardcoded
 * placeholder — so this page doubles as a visible check that the whole chain
 * works: cookie → refresh → token → guard → permission resolution.
 */
export default function DashboardPage(): React.JSX.Element {
  const { session } = useSession();

  const planned = NAV_ITEMS.filter((item) => item.status === 'planned');

  return (
    <div className="mx-auto flex max-w-shell flex-col gap-lg">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading">Your workspace</h1>
        <p className="text-body text-muted">
          Signed in as{' '}
          <span className="font-medium text-text">{session?.user.accountType ?? 'USER'}</span>.
        </p>
      </header>

      <div className="grid gap-sm lg:grid-cols-3">
        <section className="flex flex-col gap-xs rounded-lg border border-border bg-surface p-md lg:col-span-2">
          <h2 className="text-subheading">Session</h2>
          <dl className="grid grid-cols-1 gap-xs text-small sm:grid-cols-2">
            <div className="flex flex-col">
              <dt className="text-caption text-muted">Account id</dt>
              <dd className="truncate font-mono text-caption">{session?.user.id}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-caption text-muted">Permissions</dt>
              <dd className="text-caption">
                {session?.user.permissions.length === 0
                  ? 'None granted yet'
                  : session?.user.permissions.join(', ')}
              </dd>
            </div>
          </dl>
        </section>

        <section className="flex flex-col gap-xs rounded-lg border border-border bg-surface p-md">
          <h2 className="text-subheading">Appearance</h2>
          <p className="text-small text-muted">Follows your system by default.</p>
          <ThemeToggle className="mt-xs self-start" />
        </section>
      </div>

      <section className="flex flex-col gap-xs">
        <h2 className="text-subheading">Coming next</h2>
        <ul className="grid gap-xs sm:grid-cols-2 lg:grid-cols-3">
          {planned.map(({ key, label, description, icon: Icon }) => (
            <li
              key={key}
              className="flex items-start gap-xs rounded-md border border-border bg-surface p-sm"
            >
              <Icon aria-hidden className="mt-[2px] size-4 shrink-0 text-muted" />
              <div className="flex flex-col">
                <span className="text-small font-medium">{label}</span>
                <span className="text-caption text-muted">{description}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

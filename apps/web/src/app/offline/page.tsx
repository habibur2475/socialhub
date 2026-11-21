import Link from 'next/link';
import type { Metadata } from 'next';

import { buttonClass } from '@/components/ui/button-styles';

export const metadata: Metadata = {
  title: 'Offline',
  // An offline page must never be indexed or cached by a search engine.
  robots: { index: false, follow: false },
};

/**
 * Offline fallback, served by the service worker when a navigation fails.
 *
 * It is a static route with no dependencies, so it is guaranteed to be in the
 * cache. Only genuinely static content belongs here: rendering anything that
 * needs the network would produce a second failure on top of the first.
 */
export default function OfflinePage(): React.JSX.Element {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center gap-md bg-canvas px-md text-center"
    >
      <h1 className="text-heading">You are offline</h1>
      <p className="max-w-[44ch] text-body text-muted">
        SocialHub needs a connection for this page. Your work is safe — reconnect and try again.
      </p>
      <Link href="/" className={buttonClass('primary', 'md')}>
        Try again
      </Link>
    </main>
  );
}

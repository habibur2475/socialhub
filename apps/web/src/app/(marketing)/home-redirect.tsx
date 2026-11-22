'use client';

/**
 * Sends a signed-in visitor from the marketing page to their feed.
 *
 * `/` cannot be both a sales page and a feed, and it should not be: the marketing page is
 * prerendered static HTML, which is the right thing for the first visitor and the wrong
 * thing for someone who already has an account. So the static page renders, and this small
 * client component moves an authenticated visitor on. It renders nothing — the redirect
 * happens in an effect, after the session has actually been restored, because guessing
 * from a cookie during render would flash the feed at a visitor who is not signed in.
 */

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useSession } from '@/lib/session';

export const HomeRedirect = (): null => {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/feed');
  }, [router, status]);

  return null;
};

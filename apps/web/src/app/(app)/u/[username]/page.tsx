/**
 * Public profile route.
 *
 * The page is a thin server component: it unwraps the dynamic segment and hands
 * it to the client view, which owns the fetch (the access token is in memory and
 * therefore invisible to the server).
 */

import type { Metadata } from 'next';

import { ProfileView } from '@/components/profile/profile-view';

export const metadata: Metadata = {
  title: 'Profile',
  // Profiles must not be indexed: a private account's existence would leak
  // through a search result even when its content is redacted.
  robots: { index: false, follow: false },
};

export default async function ProfilePage({
  params,
}: {
  readonly params: Promise<{ username: string }>;
}): Promise<React.JSX.Element> {
  const { username } = await params;
  return <ProfileView username={username} />;
}

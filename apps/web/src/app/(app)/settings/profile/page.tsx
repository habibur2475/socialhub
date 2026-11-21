/**
 * Profile settings route.
 *
 * Fetching and form state live in a client component for the same reason as the
 * profile view: the access token cannot leave memory. This page is the layout and
 * the metadata only.
 */

import type { Metadata } from 'next';

import { ProfileSettingsView } from '@/components/profile/profile-settings-view';

export const metadata: Metadata = {
  title: 'Edit profile',
  robots: { index: false, follow: false },
};

export default function EditProfilePage(): React.JSX.Element {
  return <ProfileSettingsView />;
}

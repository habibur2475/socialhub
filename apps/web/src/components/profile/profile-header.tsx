/**
 * Profile header.
 *
 * Renders a redacted profile honestly. A hidden bio is not shown as an empty one:
 * when the server returns null the component states that the content is
 * restricted, so the reader does not conclude the account is simply blank. That
 * distinction is why redaction uses null rather than omitting the field.
 */

import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';

import type { ProfileResponse } from '@socialhub/contracts';

import { cn } from '@/lib/cn';

export type ProfileHeaderProps = {
  readonly profile: ProfileResponse;
  /** Absent on the caller's own profile: you cannot follow yourself. */
  readonly action?: ReactNode;
};

/** The first character of the display name; no network request for an avatar. */
const initialOf = (displayName: string): string =>
  displayName.trim().slice(0, 1).toUpperCase() || '?';

export const ProfileHeader = ({ profile, action }: ProfileHeaderProps): React.JSX.Element => {
  // Counts are null when the server redacted them, which only happens for a
  // non-owner, so the notice is scoped to that case.
  const restricted = !profile.isSelf && profile.followerCount === null;

  return (
    <header className="flex flex-col gap-md border-b border-border pb-lg">
      <div className="flex items-start gap-md">
        <div
          // Decorative: the display name sits beside it, so announcing the avatar
          // would repeat the same information to a screen reader.
          aria-hidden
          className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full bg-primary text-h2 font-semibold text-primary-contrast"
        >
          {initialOf(profile.displayName)}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-xs">
          <h1 className="truncate text-h2 font-semibold text-text">{profile.displayName}</h1>
          <p className="truncate text-small text-text-muted">@{profile.username}</p>
        </div>

        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>

      {restricted ? (
        <p className="flex items-center gap-xs text-small text-text-muted">
          <Lock size={14} aria-hidden />
          This profile is restricted. Follow to see more.
        </p>
      ) : profile.bio === null ? null : (
        <p className="whitespace-pre-line text-body text-text">{profile.bio}</p>
      )}

      <dl className="flex flex-wrap gap-lg text-small">
        <Stat label="Followers" value={profile.followerCount} />
        <Stat label="Following" value={profile.followingCount} />
      </dl>
    </header>
  );
};

const Stat = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | null;
}): React.JSX.Element => (
  <div className="flex items-baseline gap-xs">
    <dt className="text-text-muted">{label}</dt>
    {/* A hidden count renders as a dash rather than disappearing: a missing
        number reads as a layout bug, a dash reads as "not shared". */}
    <dd className={cn('font-semibold text-text', value === null && 'text-text-muted')}>
      {value === null ? '—' : value.toLocaleString()}
    </dd>
  </div>
);

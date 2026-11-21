'use client';

/**
 * Follow / unfollow control.
 *
 * The button flips immediately so the interaction does not feel laggy, then
 * reconciles with the server's answer. A private account answers
 * `{ following: false }` — the request is pending, not accepted — and the label
 * becomes "Requested", because showing "Following" would promise something the
 * server did not grant.
 *
 * The error path restores the previous state rather than leaving the UI claiming a
 * follow that failed.
 */

import { useState } from 'react';
import { UserMinus, UserPlus } from 'lucide-react';

import { buttonClass } from '@/components/ui/button-styles';
import { describeError } from '@/lib/form';
import { createProfileApi } from '@/lib/profile-api';
import { useSession } from '@/lib/session';

export type FollowButtonProps = {
  readonly accountId: string;
  readonly isFollowing: boolean;
  readonly followPending: boolean;
  readonly onChanged: (state: { isFollowing: boolean; followPending: boolean }) => void;
};

type Phase = 'idle' | 'busy' | 'error';

export const FollowButton = ({
  accountId,
  isFollowing,
  followPending,
  onChanged,
}: FollowButtonProps): React.JSX.Element => {
  const { client } = useSession();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const active = isFollowing || followPending;
  const api = createProfileApi(client);

  const toggle = async (): Promise<void> => {
    setPhase('busy');
    setError(null);

    try {
      if (active) {
        await api.unfollow(accountId);
        onChanged({ isFollowing: false, followPending: false });
      } else {
        const result = await api.follow(accountId);
        onChanged({ isFollowing: result.following, followPending: !result.following });
      }
      setPhase('idle');
    } catch (cause) {
      setError(describeError(cause));
      setPhase('error');
    }
  };

  return (
    <div className="flex flex-col gap-xs">
      <button
        type="button"
        // `aria-pressed` communicates the toggle state; the label alone would make
        // "Following" read as an instruction rather than a state.
        aria-pressed={active}
        aria-busy={phase === 'busy'}
        className={buttonClass(active ? 'secondary' : 'primary', 'sm')}
        onClick={() => {
          void toggle();
        }}
        disabled={phase === 'busy'}
      >
        {active ? <UserMinus size={16} aria-hidden /> : <UserPlus size={16} aria-hidden />}
        {isFollowing ? 'Following' : followPending ? 'Requested' : 'Follow'}
      </button>
      {error === null ? null : (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
};

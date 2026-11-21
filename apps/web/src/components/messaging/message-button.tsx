'use client';

/**
 * The "Message" button on a profile.
 *
 * It does not decide whether messaging is allowed: the server does, and its refusal is
 * rendered verbatim. A client-side gate would have to duplicate the mutual-follow rule
 * and would drift from the kernel the moment either changed.
 *
 * The success path navigates to the conversation. Pressing the button twice is safe —
 * the API keys a direct thread on the unordered pair and returns the existing one.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MessageSquare } from 'lucide-react';

import { buttonClass } from '@/components/ui/button-styles';
import { describeError } from '@/lib/form';
import { createMessageApi } from '@/lib/messaging-api';
import { useSession } from '@/lib/session';

export const MessageButton = ({ accountId }: { readonly accountId: string }): React.JSX.Element => {
  const { client } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const thread = await createMessageApi(client).openDirect(accountId);
      router.push(`/messages/${thread.id}`);
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-xs">
      <button
        type="button"
        onClick={() => void start()}
        disabled={busy}
        className={buttonClass('secondary', 'sm')}
      >
        <MessageSquare aria-hidden className="size-4" />
        {busy ? 'Opening…' : 'Message'}
      </button>
      {error !== null ? (
        <p role="alert" className="max-w-[220px] text-right text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
};

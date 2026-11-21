'use client';

/**
 * Starting a conversation.
 *
 * One form, two modes, because the two are the same question asked with a different
 * number of people: who am I talking to?
 *
 * People are named by **username**, not by account id: an id is not something a user
 * knows, and a form that asked for one would be a form only an API client could fill in.
 * Each username is resolved to a profile first, so a mistyped name is an error under the
 * field rather than a server refusal after the conversation is created.
 *
 * In group mode the creator is added implicitly — the server does that — so the field is
 * labelled "other people" and the owner never types their own name.
 */

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Users } from 'lucide-react';

import type { ProfileResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMessageApi } from '@/lib/messaging-api';
import { createProfileApi } from '@/lib/profile-api';
import { useSession } from '@/lib/session';

const split = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((entry) => entry.replace(/^@/, '').trim())
    .filter((entry) => entry.length > 0);

export const NewConversation = (): React.JSX.Element => {
  const { client, status: sessionStatus, session } = useSession();
  const router = useRouter();

  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [people, setPeople] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<readonly ProfileResponse[]>([]);

  const api = useMemo(() => createMessageApi(client), [client]);
  const profiles = useMemo(() => createProfileApi(client), [client]);

  /**
   * Resolves the typed names as they are typed.
   *
   * A 300 ms settle is enough to stop a request per keystroke, and the result is what the
   * submit button reads — so a name that does not resolve is never sent.
   */
  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;

    const usernames = split(people);
    if (usernames.length === 0) {
      setResolved([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const found: ProfileResponse[] = [];
        for (const username of usernames) {
          try {
            found.push(await profiles.getByUsername(username));
          } catch {
            // An unknown name is surfaced by the submit path, which can name the field;
            // the lookup itself must not throw into the render.
          }
        }
        if (!cancelled) setResolved(found);
      })();
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [people, profiles, sessionStatus]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;

    const usernames = split(people);
    if (usernames.length === 0) {
      setError('Enter at least one username');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const accounts: string[] = [];
      for (const username of usernames) {
        const profile = await profiles.getByUsername(username);
        accounts.push(profile.accountId);
      }

      const thread =
        mode === 'direct'
          ? await api.openDirect(accounts[0] as string)
          : await api.createGroup({ title: title.trim(), memberIds: accounts });

      router.push(`/messages/${thread.id}`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[560px] flex-col gap-lg">
      <header className="flex items-center gap-sm">
        <Link
          href="/messages"
          aria-label="Back to messages"
          className="rounded-full p-xs text-muted transition-colors hover:bg-raised"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </Link>
        <h1 className="text-heading">New conversation</h1>
      </header>

      <div className="flex gap-xs">
        <button
          type="button"
          onClick={() => setMode('direct')}
          aria-current={mode === 'direct' ? 'true' : undefined}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            mode === 'direct'
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-muted hover:bg-raised',
          )}
        >
          One person
        </button>
        <button
          type="button"
          onClick={() => setMode('group')}
          aria-current={mode === 'group' ? 'true' : undefined}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            mode === 'group'
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-muted hover:bg-raised',
          )}
        >
          <Users aria-hidden className="mr-xs inline size-3" />A group
        </button>
      </div>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-md">
        {mode === 'group' ? (
          <div className="flex flex-col gap-xs">
            <label htmlFor="group-title" className="text-small font-medium">
              Group name
            </label>
            <input
              id="group-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              placeholder="Release planning"
              className="h-11 rounded-lg border border-border bg-surface px-sm text-body outline-none focus:border-primary"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-xs">
          <label htmlFor="people" className="text-small font-medium">
            {mode === 'direct' ? 'Username' : 'Usernames, separated by commas'}
          </label>
          <input
            id="people"
            value={people}
            onChange={(event) => setPeople(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={mode === 'direct' ? 'ada' : 'ada, grace, linus'}
            className="h-11 rounded-lg border border-border bg-surface px-sm text-body outline-none focus:border-primary"
          />

          {split(people).length > 0 ? (
            <p className="text-caption text-muted">
              {resolved.length === split(people).length
                ? `Found ${resolved.map((profile) => `@${profile.username}`).join(', ')}`
                : 'Looking up those usernames…'}
            </p>
          ) : null}

          <p className="text-caption text-muted">
            You can message someone you follow, someone who follows you, or anyone once you already
            share a conversation. A block ends it in both directions.
          </p>
        </div>

        {error !== null ? (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || session === null}
          className={cn(buttonClass('primary', 'md'), 'self-start')}
        >
          {busy ? 'Starting…' : mode === 'direct' ? 'Start conversation' : 'Create group'}
        </button>
      </form>
    </div>
  );
};

'use client';

/**
 * The transcript.
 *
 * Three decisions:
 *
 * 1. **Reading marks the thread read, once per arrival.** The call is debounced by the
 *    newest message id, not by a timer: a burst of frames marks read once, and a single
 *    later message marks it again.
 * 2. **The composer keeps the draft through a failure.** A failed send leaves the text
 *    in the box and the same `clientId`, so pressing send again is a retry, not a
 *    duplicate.
 * 3. **A live frame is appended, never re-fetched.** The transcript already holds
 *    everything before the new message; refetching the page would throw away the
 *    reader's scroll position to learn one row.
 */

import Link from 'next/link';
import { ArrowLeft, Lock, Send, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageView, ThreadSummary } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMessageApi, newClientId } from '@/lib/messaging-api';
import { useNotificationStream } from '@/lib/notification-stream';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

export const ThreadView = ({ threadId }: { readonly threadId: string }): React.JSX.Element => {
  const { client, status: sessionStatus, session } = useSession();

  const api = useMemo(() => createMessageApi(client), [client]);

  const [thread, setThread] = useState<ThreadSummary | null>(null);
  const [messages, setMessages] = useState<readonly MessageView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const bottom = useRef<HTMLDivElement | null>(null);
  // One client id per draft: it is regenerated only after a successful send, so a
  // retry of the same failed attempt carries the same key.
  const clientId = useRef<string>(newClientId());
  const lastRead = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const [summary, page] = await Promise.all([
        api.conversation(threadId),
        api.messages(threadId),
      ]);
      setThread(summary);
      setMessages(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [api, sessionStatus, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Marks read once per newest message id. */
  const markRead = useCallback(
    async (newest: MessageView | undefined): Promise<void> => {
      if (newest === undefined || lastRead.current === newest.id) return;
      lastRead.current = newest.id;
      // A failed read marker is harmless: the cursor simply stays where it was and the
      // next visit tries again.
      await api.markRead(threadId).catch(() => undefined);
      setThread((current) => (current === null ? current : { ...current, unreadCount: 0 }));
    },
    [api, threadId],
  );

  useEffect(() => {
    if (status !== 'ready') return;
    void markRead(messages[messages.length - 1]);
  }, [markRead, messages, status]);

  useEffect(() => {
    // Only after the first page is in place: scrolling an empty list to the bottom does
    // nothing useful.
    if (status !== 'ready') return;
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [status]);

  useNotificationStream((data) => {
    if (typeof data !== 'object' || data === null) return;
    const frame = data as {
      type?: unknown;
      threadId?: string;
      message?: MessageView;
      messageId?: string;
    };

    if (frame.threadId !== threadId) return;

    if (frame.type === 'message' && frame.message !== undefined) {
      const incoming = frame.message;
      setMessages((current) =>
        // The sender's own tab receives its message too; the id makes that idempotent.
        current.some((existing) => existing.id === incoming.id) ? current : [...current, incoming],
      );
      setThread((current) =>
        current === null
          ? current
          : {
              ...current,
              lastMessageAt: incoming.createdAt,
              lastMessagePreview: incoming.deleted ? null : incoming.body.slice(0, 120),
            },
      );
      return;
    }

    if (frame.type === 'message-deleted' && frame.message !== undefined) {
      const updated = frame.message;
      setMessages((current) =>
        current.map((existing) => (existing.id === updated.id ? updated : existing)),
      );
    }
  });

  const send = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const body = draft.trim();
    if (body.length === 0 || sending) return;

    setSending(true);
    setSendError(null);

    try {
      const result = await api.send(threadId, { body, clientId: clientId.current });
      // The frame may arrive before this response; the id check keeps one row.
      setMessages((current) =>
        current.some((existing) => existing.id === result.message.id)
          ? current
          : [...current, result.message],
      );
      setDraft('');
      clientId.current = newClientId();
      lastRead.current = result.message.id;
      requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
    } catch (cause) {
      // The draft and its client id survive, so pressing send again is a retry.
      setSendError(describeError(cause));
    } finally {
      setSending(false);
    }
  };

  const loadOlder = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingOlder(true);

    try {
      const page = await api.messages(threadId, { before: cursor });
      setMessages((current) => [...page.items, ...current]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setSendError(describeError(cause));
    } finally {
      setLoadingOlder(false);
    }
  };

  const remove = async (messageId: string): Promise<void> => {
    try {
      await api.deleteMessage(threadId, messageId);
      setMessages((current) =>
        current.map((existing) =>
          existing.id === messageId
            ? { ...existing, deleted: true, body: 'This message was deleted' }
            : existing,
        ),
      );
    } catch (cause) {
      setSendError(describeError(cause));
    }
  };

  const leave = async (): Promise<void> => {
    try {
      await api.leave(threadId);
      window.location.assign('/messages');
    } catch (cause) {
      setSendError(describeError(cause));
    }
  };

  const now = new Date();

  if (status === 'loading') {
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-sm" aria-busy>
        <div className="skeleton h-6 w-48" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-3/4" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-sm rounded-lg border border-border p-md">
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
        <p className="text-small text-muted">
          A conversation you cannot see does not exist for you — a block hides it in both
          directions, including the messages that came before it.
        </p>
        <Link href="/messages" className="text-small font-medium text-primary underline">
          Back to messages
        </Link>
      </div>
    );
  }

  const canSend = thread !== null && !thread.locked;
  const isGroup = thread?.kind === 'GROUP';

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-md">
      <header className="flex flex-wrap items-center gap-sm">
        <Link
          href="/messages"
          aria-label="Back to messages"
          className="rounded-full p-xs text-muted transition-colors hover:bg-raised"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </Link>

        <div className="flex min-w-0 flex-col">
          <h1 className="flex items-center gap-xs truncate text-heading">
            {isGroup ? <Users aria-label="Group" className="size-4 shrink-0 text-muted" /> : null}
            {thread?.title ?? 'Conversation'}
            {thread?.locked === true ? (
              <Lock aria-label="Locked" className="size-3 shrink-0 text-muted" />
            ) : null}
          </h1>
          <p className="truncate text-caption text-muted">
            {thread?.participants
              .filter((participant) => participant.accountId !== session?.user.id)
              .map((participant) => participant.displayName)
              .join(', ') ?? ''}
          </p>
        </div>

        {isGroup && thread?.viewerIsOwner === true ? (
          <button
            type="button"
            onClick={() => void leave()}
            className={cn(buttonClass('secondary', 'sm'), 'ml-auto')}
          >
            Leave group
          </button>
        ) : null}
      </header>

      <div className="flex min-h-[320px] flex-col gap-sm">
        {cursor !== null ? (
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            className={cn(buttonClass('secondary', 'sm'), 'self-center')}
          >
            {loadingOlder ? 'Loading…' : 'Load earlier messages'}
          </button>
        ) : null}

        {messages.length === 0 ? (
          <p className="rounded-lg border border-border p-lg text-body text-muted">
            No messages yet. Say something — the first message is the one that makes this a
            conversation.
          </p>
        ) : null}

        <ul className="flex flex-col gap-xs">
          {messages.map((message) => {
            const mine = message.sender.accountId === session?.user.id;

            return (
              <li
                key={message.id}
                className={cn('flex flex-col gap-[2px]', mine ? 'items-end' : 'items-start')}
              >
                <div
                  className={cn(
                    'max-w-[86%] rounded-lg px-sm py-xs text-body',
                    mine ? 'bg-primary text-on-primary' : 'bg-raised text-foreground',
                    message.deleted && 'italic opacity-70',
                  )}
                >
                  {isGroup && !mine ? (
                    <span className="mb-[2px] block text-caption font-medium opacity-80">
                      {message.sender.displayName}
                    </span>
                  ) : null}
                  {/* `whitespace-pre-wrap`: a message keeps its line breaks, and a newline
                      is content rather than markup. */}
                  <span className="whitespace-pre-wrap break-words">{message.body}</span>
                </div>

                <span className="flex items-center gap-xs text-caption text-muted">
                  <span suppressHydrationWarning>{relativeTime(message.createdAt, now)}</span>
                  {mine && !message.deleted ? (
                    <button
                      type="button"
                      onClick={() => void remove(message.id)}
                      aria-label="Delete message"
                      className="rounded-full p-[2px] transition-colors hover:bg-raised"
                    >
                      <Trash2 aria-hidden className="size-3" />
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        <div ref={bottom} />
      </div>

      {sendError !== null ? (
        <p role="alert" className="text-small text-danger">
          {sendError}
        </p>
      ) : null}

      {canSend ? (
        <form onSubmit={(event) => void send(event)} className="flex items-end gap-sm">
          <label htmlFor="message-draft" className="sr-only">
            Message
          </label>
          <textarea
            id="message-draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline — the convention every chat client
              // uses, and the reason the composer is a textarea rather than an input.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            maxLength={4_000}
            placeholder="Write a message"
            className="min-h-[44px] flex-1 resize-y rounded-lg border border-border bg-surface px-sm py-xs text-body outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={sending || draft.trim().length === 0}
            className={buttonClass('primary', 'sm')}
          >
            <Send aria-hidden className="size-4" />
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      ) : (
        <p className="rounded-lg border border-border p-md text-small text-muted">
          This conversation is locked. The history stays readable; nobody can add to it.
        </p>
      )}
    </div>
  );
};

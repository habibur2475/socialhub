'use client';

/**
 * Notes.
 *
 * The one tool with a server behind it, and the UI is shaped by the one promise that makes
 * that worth it: **a note written here appears on the other device, or the server is not
 * earning its privacy cost.** So there is no "save" button and no dirty state — typing
 * debounces into a `PATCH`, and the header says "Saved" only once the server answered.
 *
 * The list is the server's order (pinned first, then newest edit) and is never re-sorted
 * client-side: a second comparator is a second definition of the order, and the two drift.
 *
 * Search goes through the API rather than filtering the fetched page. Filtering in the
 * browser would only search the page that happens to be loaded, which is the bug that makes
 * a search box feel broken on the tenth note.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NotebookPen, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';

import type { NoteListResponse, NoteResponse } from '@socialhub/contracts';

import { ToolShell } from '@/components/tools/tool-shell';
import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { useSession } from '@/lib/session';

type Status = 'loading' | 'ready' | 'error';

const API = '/api/v1/tools/notes';

export const NotesTool = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [notes, setNotes] = useState<readonly NoteResponse[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const saveTimer = useRef<number | null>(null);
  const pending = useRef<{ id: string; body: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;
    setStatus('loading');
    setError(null);

    try {
      const query = search.trim() === '' ? '' : `?q=${encodeURIComponent(search.trim())}`;
      const page = await client.request<NoteListResponse>(`${API}${query}`);
      setNotes(page.items);
      setTotal(page.total);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, search, sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    // One debounce for typing and for the search box alike: every keystroke must not be a
    // request, and the search is a request the same way a save is.
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load, sessionStatus]);

  const active = useMemo(
    () => notes.find((note) => note.id === activeId) ?? null,
    [notes, activeId],
  );

  useEffect(() => {
    if (active !== null) setDraft(active.body);
  }, [active]);

  const flush = useCallback(async (): Promise<void> => {
    const queued = pending.current;
    if (queued === null) return;
    pending.current = null;
    setSaveState('saving');

    try {
      const updated = await client.request<NoteResponse>(`${API}/${queued.id}`, {
        method: 'PATCH',
        body: { body: queued.body },
      });
      setNotes((current) => current.map((note) => (note.id === updated.id ? updated : note)));
      setSaveState('saved');
    } catch (cause) {
      setError(describeError(cause));
      setSaveState('idle');
    }
  }, [client]);

  const schedule = (id: string, body: string): void => {
    pending.current = { id, body };
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 700);
  };

  const edit = (body: string): void => {
    setDraft(body);
    if (activeId === null) return;
    schedule(activeId, body);
  };

  /** Leaving the note must not lose the last keystrokes before the debounce fires. */
  const select = async (id: string): Promise<void> => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    await flush();
    setActiveId(id);
    setSaveState('idle');
  };

  const create = async (): Promise<void> => {
    try {
      const created = await client.request<NoteResponse>(API, {
        method: 'POST',
        body: { body: 'New note\n' },
      });
      setNotes((current) => [created, ...current]);
      setTotal((current) => current + 1);
      setActiveId(created.id);
      setDraft(created.body);
      setSaveState('idle');
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const togglePin = async (note: NoteResponse): Promise<void> => {
    try {
      await client.request<NoteResponse>(`${API}/${note.id}`, {
        method: 'PATCH',
        body: { pinned: !note.pinned },
      });
      // The order is the server's, so a pin change is followed by a reload rather than a
      // local re-sort. That is one request for a rare action and one ordering rule in total.
      await load();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const remove = async (note: NoteResponse): Promise<void> => {
    try {
      await client.request<void>(`${API}/${note.id}`, { method: 'DELETE' });
      setNotes((current) => current.filter((item) => item.id !== note.id));
      setTotal((current) => Math.max(0, current - 1));
      if (activeId === note.id) {
        setActiveId(null);
        setDraft('');
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  return (
    <ToolShell
      title="Notes"
      icon={NotebookPen}
      description="Short notes that follow you to another device. The first line is the title, so a note called “Shopping” is findable as Shopping without an extra field."
      handling="server"
    >
      <div className="grid gap-md md:grid-cols-[280px_1fr]">
        <div className="flex min-w-0 flex-col gap-sm">
          <div className="flex gap-xs">
            <label htmlFor="notes-search" className="sr-only">
              Search notes
            </label>
            <span className="relative flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-sm top-1/2 size-4 -translate-y-1/2 text-muted"
              />
              <input
                id="notes-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search"
                className="h-11 w-full rounded-lg border border-border bg-surface pl-xl pr-sm text-small outline-none focus:border-primary"
              />
            </span>
            <button
              type="button"
              onClick={() => void create()}
              aria-label="New note"
              className={buttonClass('primary', 'sm')}
            >
              <Plus aria-hidden className="size-4" />
            </button>
          </div>

          {status === 'loading' ? (
            <div className="flex flex-col gap-xs" aria-busy>
              {[0, 1, 2].map((key) => (
                <div key={key} className="skeleton h-14 w-full" />
              ))}
            </div>
          ) : null}

          {status === 'error' ? (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}

          {status === 'ready' && notes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-md text-small text-muted">
              {search.trim() === ''
                ? 'No notes yet. Press + to start one.'
                : 'Nothing matches that search.'}
            </p>
          ) : null}

          <ul className="flex flex-col gap-xs">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => void select(note.id)}
                  aria-current={note.id === activeId ? 'true' : undefined}
                  className={cn(
                    'flex w-full flex-col gap-[2px] rounded-lg border p-sm text-left transition-colors',
                    note.id === activeId
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-raised',
                  )}
                >
                  <span className="flex items-center gap-xs">
                    {note.pinned ? (
                      <Pin aria-hidden className="size-3 shrink-0 text-primary" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-small font-medium">
                      {note.title === '' ? note.body.split('\n', 1)[0]?.slice(0, 60) : note.title}
                    </span>
                  </span>
                  <span className="text-caption text-muted">
                    {note.words} word{note.words === 1 ? '' : 's'} · {note.updatedAt.slice(0, 10)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {status === 'ready' && total > notes.length ? (
            <p className="text-caption text-muted">
              Showing {notes.length} of {total}. Search to narrow it down.
            </p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-sm">
          {active === null ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-sm rounded-lg border border-dashed border-border p-lg text-center">
              <NotebookPen aria-hidden className="size-6 text-muted" />
              <p className="text-small text-muted">
                Choose a note, or press <span className="font-medium text-text">+</span> to write
                one.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-xs">
                <span className="text-caption text-muted">
                  {saveState === 'saving'
                    ? 'Saving…'
                    : saveState === 'saved'
                      ? 'Saved'
                      : `Edited ${active.updatedAt.slice(0, 16).replace('T', ' ')}`}
                </span>

                <span className="ml-auto flex items-center gap-xs">
                  <button
                    type="button"
                    onClick={() => void togglePin(active)}
                    className={buttonClass('ghost', 'sm')}
                  >
                    {active.pinned ? (
                      <PinOff aria-hidden className="size-4" />
                    ) : (
                      <Pin aria-hidden className="size-4" />
                    )}
                    {active.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(active)}
                    className={buttonClass('danger', 'sm')}
                  >
                    <Trash2 aria-hidden className="size-4" />
                    Delete
                  </button>
                </span>
              </div>

              <label htmlFor="note-body" className="sr-only">
                Note text
              </label>
              <textarea
                id="note-body"
                value={draft}
                onChange={(event) => edit(event.target.value)}
                onBlur={() => void flush()}
                rows={18}
                className="min-h-[280px] resize-y rounded-lg border border-border bg-surface p-sm font-mono text-small leading-relaxed outline-none focus:border-primary"
              />
              <p className="text-caption text-muted">
                The first line becomes the title. {draft.length.toLocaleString()} characters.
              </p>
            </>
          )}

          {error !== null && status !== 'error' ? (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </ToolShell>
  );
};

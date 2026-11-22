/**
 * Notes service rules.
 *
 * What the service decides: that the title is derived rather than accepted, that a pin-only
 * patch does not rewrite the body, that the cursor is the last row's sort key, and that
 * somebody else's note is a `404` rather than a `403`. The database properties (ownership,
 * the index order, the cascade) live in the schema suite and the routes in the e2e suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { ToolsService, encodeCursor } from './tools.service.js';
import type { NoteListQuery, NotePage, NoteRecord, NoteStore } from './ports.js';

const OWNER = '0190f3c1-0000-7000-8000-00000000000a';
const NOTE = '0190f3c1-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-11-21T09:00:00.000Z');

const note = (overrides: Partial<NoteRecord> = {}): NoteRecord => ({
  id: NOTE,
  ownerId: OWNER,
  title: 'Shopping',
  body: 'Shopping\nmilk\neggs',
  pinned: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const createService = (
  options: {
    existing?: NoteRecord | null;
    page?: NotePage;
    returned?: NoteRecord;
    removed?: boolean;
  } = {},
) => {
  const store = {
    list: vi.fn(async () => options.page ?? { items: [], total: 0 }),
    find: vi.fn(async () => ('existing' in options ? options.existing : note())),
    create: vi.fn(async (record: NoteRecord) => options.returned ?? record),
    update: vi.fn(async () => ('returned' in options ? options.returned : note())),
    remove: vi.fn(async () => options.removed ?? true),
  } satisfies NoteStore;

  const service = new ToolsService(store, { next: () => NOTE }, () => NOW);
  return { service, store };
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ error: { code } });
};

describe('creating a note', () => {
  it('derives the title from the first line and counts the words', async () => {
    const { service, store } = createService();

    const created = await service.createNote(OWNER, { body: 'Shopping\nmilk\neggs' });

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: NOTE,
        ownerId: OWNER,
        title: 'Shopping',
        body: 'Shopping\nmilk\neggs',
        pinned: false,
      }),
    );
    expect(created.words).toBe(3);
  });

  it('leaves a prose note untitled rather than inventing a heading', async () => {
    const { service, store } = createService();
    await service.createNote(OWNER, { body: `${'long prose '.repeat(12)}\nmore` });
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ title: '' }));
  });

  it('honours a pin supplied at creation', async () => {
    const { service, store } = createService();
    await service.createNote(OWNER, { body: 'Pinned from the start', pinned: true });
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ pinned: true }));
  });
});

describe('editing a note', () => {
  it('re-derives the title when the body changes', async () => {
    const { service, store } = createService();
    await service.updateNote(OWNER, NOTE, { body: 'Work\ncall the bank' });
    expect(store.update).toHaveBeenCalledWith(OWNER, NOTE, {
      body: 'Work\ncall the bank',
      title: 'Work',
    });
  });

  /** A pin toggle must not rewrite the body, or the note's updated_at moves for nothing. */
  it('does not touch the body or title for a pin-only patch', async () => {
    const { service, store } = createService();
    await service.updateNote(OWNER, NOTE, { pinned: true });
    expect(store.update).toHaveBeenCalledWith(OWNER, NOTE, { pinned: true });
  });

  it('answers 404 for a note that is not yours', async () => {
    const { service, store } = createService({ existing: null });
    await expectCode(service.updateNote(OWNER, NOTE, { pinned: true }), 'NOT_FOUND');
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('reading notes', () => {
  it('pages with the last row as the cursor', async () => {
    const second = note({ id: '0190f3c1-0000-7000-8000-0000000000e2', updatedAt: NOW });
    const { service } = createService({
      page: { items: [note(), second], total: 5 },
    });

    const page = await service.listNotes(OWNER, {
      limit: 2,
      cursor: undefined,
      q: undefined,
      pinned: undefined,
    } as never);

    expect(page.total).toBe(5);
    expect(page.nextCursor).toBe(encodeCursor(second));
  });

  /**
   * The order the list uses is `pinned DESC, updated_at DESC, id DESC`, so the cursor has to
   * carry the pin flag too — otherwise page two starts in the wrong half of the list.
   */
  it('puts the pin flag in the cursor, ahead of the timestamp', () => {
    expect(encodeCursor(note({ pinned: true }))).toBe(`1|${NOW.toISOString()}|${NOTE}`);
    expect(encodeCursor(note({ pinned: false }))).toBe(`0|${NOW.toISOString()}|${NOTE}`);
  });

  it('stops paging when the page came back short', async () => {
    const { service } = createService({ page: { items: [note()], total: 1 } });
    const page = await service.listNotes(OWNER, {
      limit: 50,
      cursor: undefined,
      q: undefined,
      pinned: undefined,
    } as never);
    expect(page.nextCursor).toBeNull();
  });

  it('has no cursor for an empty page', async () => {
    const { service } = createService({ page: { items: [], total: 0 } });
    const page = await service.listNotes(OWNER, {
      limit: 50,
      cursor: undefined,
      q: undefined,
      pinned: undefined,
    } as never);
    expect(page).toMatchObject({ nextCursor: null, total: 0, items: [] });
  });

  it('passes the search and the pin filter through unchanged', async () => {
    const { service, store } = createService();
    await service.listNotes(OWNER, { limit: 10, cursor: 'c', q: ' milk ', pinned: true } as never);
    expect(store.list).toHaveBeenCalledWith({
      ownerId: OWNER,
      limit: 10,
      cursor: 'c',
      search: ' milk ',
      pinned: true,
    } satisfies NoteListQuery);
  });

  it('answers 404 for a note that does not exist, rather than an empty object', async () => {
    const { service } = createService({ existing: null });
    await expectCode(service.note(OWNER, NOTE), 'NOT_FOUND');
  });
});

describe('deleting a note', () => {
  it('deletes a note you own', async () => {
    const { service } = createService();
    await expect(service.removeNote(OWNER, NOTE)).resolves.toBeUndefined();
  });

  it('answers 404 when nothing was deleted', async () => {
    const { service } = createService({ removed: false });
    await expectCode(service.removeNote(OWNER, NOTE), 'NOT_FOUND');
  });
});

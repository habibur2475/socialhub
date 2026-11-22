import { describe, expect, it } from 'vitest';

import {
  NOTE_MAX_LENGTH,
  checkNoteText,
  noteHeadingOf,
  noteMatches,
  noteTitleOf,
  noteWords,
  orderNotes,
  printableNote,
} from './notes.js';

describe('note titles', () => {
  it('takes a short first line as the title', () => {
    expect(noteTitleOf('Shopping\nmilk\neggs')).toBe('Shopping');
    expect(noteTitleOf('')).toBe('');
  });

  it('treats a long first line as prose, not a title', () => {
    expect(noteTitleOf(`${'x'.repeat(81)}\nbody`)).toBe('');
  });

  it('falls back to a truncated first line for the list row', () => {
    const heading = noteHeadingOf(`${'words '.repeat(40)}`);
    expect(heading.endsWith('…')).toBe(true);
    expect([...heading].length).toBeLessThanOrEqual(80);
  });

  it('counts words the way a person would', () => {
    expect(noteWords('one  two\nthree')).toBe(3);
    expect(noteWords('   ')).toBe(0);
  });
});

describe('note rules', () => {
  it('refuses an empty note and one beyond the ceiling', () => {
    expect(checkNoteText('   ')).toEqual({ code: 'NOTE_EMPTY' });
    expect(checkNoteText('x'.repeat(NOTE_MAX_LENGTH + 1))).toEqual({ code: 'NOTE_TOO_LONG' });
    expect(checkNoteText('a note')).toBeNull();
  });

  it('separates the title line from the body for printing', () => {
    expect(printableNote('Shopping\nmilk\n eggs')).toEqual({
      ok: true,
      value: { title: 'Shopping', body: 'milk\n eggs', words: 3 },
    });
  });
});

describe('ordering and search', () => {
  const notes = [
    { id: 'b', pinned: false, updatedAt: '2026-11-20T10:00:00.000Z' },
    { id: 'a', pinned: true, updatedAt: '2026-11-01T10:00:00.000Z' },
    { id: 'c', pinned: false, updatedAt: '2026-11-21T10:00:00.000Z' },
    { id: 'd', pinned: false, updatedAt: '2026-11-20T10:00:00.000Z' },
  ];

  it('puts pinned notes first, then the newest edit, tie-broken by id', () => {
    expect(orderNotes(notes).map((note) => note.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('does not mutate the input', () => {
    const copy = [...notes];
    orderNotes(notes);
    expect(notes).toEqual(copy);
  });

  it('searches case- and accent-insensitively', () => {
    expect(noteMatches('Café notes', 'café')).toBe(true);
    expect(noteMatches('Cafe notes', 'CAFÉ')).toBe(true);
    expect(noteMatches('Cafe notes', 'tea')).toBe(false);
    expect(noteMatches('anything', '  ')).toBe(true);
  });
});

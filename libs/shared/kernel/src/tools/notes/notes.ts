/**
 * Notes.
 *
 * A note is text plus a compute. Two rules that are policy rather than formatting:
 *
 *   * **The first line is the title when it is short.** A note that opens with "Shopping"
 *     should be findable as "Shopping" without asking its author to fill in a field they
 *     did not want. A long first line is prose, and a note made of prose is untitled.
 *   * **Pinning is a separate fact from recency.** Pinned-first is what makes a notes list
 *     usable, and it cannot be derived from `updated_at` — a pinned note is pinned exactly
 *     because it is not the most recent thing you touched.
 */

import { type Result, fail, ok } from '../../result.js';

export const NOTE_MAX_LENGTH = 20_000;
export const NOTE_TITLE_MAX_LENGTH = 80;

export const noteTitleOf = (text: string): string => {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 0 && firstLine.length <= NOTE_TITLE_MAX_LENGTH ? firstLine : '';
};

/** What a list row shows when the note has no title of its own. */
export const noteHeadingOf = (text: string): string => {
  const title = noteTitleOf(text);
  if (title !== '') return title;
  const flattened = text.replace(/\s+/gu, ' ').trim();
  const characters = [...flattened];
  return characters.length <= NOTE_TITLE_MAX_LENGTH
    ? flattened
    : `${characters
        .slice(0, NOTE_TITLE_MAX_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
};

export const noteWords = (text: string): number =>
  text.trim() === ''
    ? 0
    : text
        .trim()
        .split(/\s+/u)
        .filter((word) => word !== '').length;

export type NoteRefusal = { readonly code: 'NOTE_EMPTY' } | { readonly code: 'NOTE_TOO_LONG' };

export const checkNoteText = (text: string): NoteRefusal | null => {
  if (text.trim() === '') return { code: 'NOTE_EMPTY' };
  if ([...text].length > NOTE_MAX_LENGTH) return { code: 'NOTE_TOO_LONG' };
  return null;
};

export type SortableNote = {
  readonly id: string;
  readonly pinned: boolean;
  readonly updatedAt: string;
};

/**
 * Pinned first, then newest edit, tie-broken by id.
 *
 * The id tie-break is not decoration: two notes saved in the same millisecond otherwise
 * swap places between renders, and a list that reorders itself under the pointer is a list
 * where the second click lands on the wrong row.
 */
export const orderNotes = <Note extends SortableNote>(notes: readonly Note[]): Note[] =>
  [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

/** Full-text search over title and body, case- and diacritic-insensitive enough. */
export const noteMatches = (text: string, query: string): boolean => {
  const needle = query.trim();
  if (needle === '') return true;
  // Both sides are decomposed and stripped of combining marks before comparing, so a note
  // typed with `é` is still found by someone typing `e` on a keyboard without that key —
  // which is most keyboards in the world.
  const fold = (value: string): string =>
    value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  return fold(text).includes(fold(needle));
};

/** A printable note never contains the raw marker of a hidden field. */
export const printableNote = (
  text: string,
): Result<{ title: string; body: string; words: number }, NoteRefusal> => {
  const refusal = checkNoteText(text);
  if (refusal !== null) return fail(refusal);

  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const title = noteTitleOf(text);
  const body = (title === '' ? lines : lines.slice(1)).join('\n').trim();

  return ok({ title, body, words: noteWords(text) });
};

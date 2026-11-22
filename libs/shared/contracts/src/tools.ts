/**
 * Tools contracts.
 *
 * Only notes have an HTTP surface. The other six tools are arithmetic over content the
 * person already has, and giving them endpoints would mean storing a period log or a
 * household ledger on a server for no user-visible gain — so there is no schema here for
 * them, deliberately, and a reader looking for `budgetContract` should take the absence as
 * the design.
 *
 * The note schemas are the note rules from the kernel, restated as a boundary: the title is
 * derived by the server (`noteTitleOf`) rather than accepted from the client, because a
 * client-supplied title is a second source of truth for the same string.
 */

import { z } from 'zod';

import { NOTE_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH } from '@socialhub/kernel/browser';

export { NOTE_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH };

/** `pinned` is a boolean on the wire, but `?pinned=true` arrives as a string. */
export const createNoteRequestSchema = z
  .object({
    body: z
      .string()
      .refine((value) => value.trim() !== '', 'Write something first')
      .refine(
        (value) => [...value].length <= NOTE_MAX_LENGTH,
        `A note is at most ${NOTE_MAX_LENGTH.toLocaleString()} characters`,
      ),
    pinned: z.boolean().optional(),
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

/**
 * An edit.
 *
 * `pinned` alone is a valid patch: toggling a pin is the most common edit a notes list gets,
 * and requiring a body alongside it would be a rule that exists for the server's convenience
 * rather than the author's.
 */
export const updateNoteRequestSchema = z
  .object({
    body: z
      .string()
      .refine((value) => value.trim() !== '', 'A note cannot be emptied')
      .refine(
        (value) => [...value].length <= NOTE_MAX_LENGTH,
        `A note is at most ${NOTE_MAX_LENGTH.toLocaleString()} characters`,
      )
      .optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => patch.body !== undefined || patch.pinned !== undefined, 'Nothing to change');

export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

export const noteQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(120).optional(),
    /** A substring of the title or body; folded case- and accent-insensitively. */
    q: z.string().trim().max(100).optional(),
    pinned: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  })
  .strict();

export type NoteQuery = z.infer<typeof noteQuerySchema>;

export type NoteResponse = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly pinned: boolean;
  readonly words: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type NoteListResponse = {
  readonly items: readonly NoteResponse[];
  readonly nextCursor: string | null;
  readonly total: number;
};

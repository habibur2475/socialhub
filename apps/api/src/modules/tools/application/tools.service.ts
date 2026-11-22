/**
 * Tools use cases — the server half of the tools module.
 *
 * The split is deliberate and it is the most important decision in this module: **six of
 * the seven tools never reach this service.** A PDF, a QR code, a calculator, a birthday, a
 * household ledger and a period log are all content the person already has on their device,
 * and moving any of them onto a server would create a copy that can be breached, subpoenaed
 * or leaked by a bad backup — for no feature the user asked for.
 *
 * Notes are the exception, because "find it again on my phone" is the entire point of a note,
 * and that requires a server. So this service exists for notes and says so.
 *
 * The note rules are the kernel's (`noteTitleOf`, `noteWords`, `checkNoteText`,
 * `orderNotes`), imported rather than re-implemented: the list must sort the way the
 * contract says it sorts, and the title stored must be the title the browser would derive.
 */

import { Inject, Injectable } from '@nestjs/common';

import { noteTitleOf, noteWords } from '@socialhub/kernel';
import type {
  CreateNoteRequest,
  NoteListResponse,
  NoteQuery,
  NoteResponse,
  UpdateNoteRequest,
} from '@socialhub/contracts';

import { DomainException } from '../../../common/filters/domain-exception.js';
import { appError } from '@socialhub/kernel';
import type { Clock, IdGenerator } from '../../auth/application/ports.js';
import { CLOCK, IDS } from '../../auth/auth.tokens.js';
import type { NoteRecord, NoteStore } from './ports.js';
import { NOTE_STORE } from '../tools.tokens.js';

/**
 * The cursor is the last row's **whole** sort key, not just its timestamp.
 *
 * The list orders by `pinned DESC, updated_at DESC, id DESC`, so a cursor carrying only the
 * timestamp would page straight through the boundary between the pinned notes and the
 * rest: the row comparison needs all three parts to mean "everything after this note".
 */
export const encodeCursor = (note: NoteRecord): string =>
  `${note.pinned ? '1' : '0'}|${note.updatedAt.toISOString()}|${note.id}`;

@Injectable()
export class ToolsService {
  public constructor(
    @Inject(NOTE_STORE) private readonly notes: NoteStore,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private toResponse(note: NoteRecord): NoteResponse {
    return {
      id: note.id,
      title: note.title,
      body: note.body,
      pinned: note.pinned,
      words: noteWords(note.body),
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
    };
  }

  public async listNotes(ownerId: string, query: NoteQuery): Promise<NoteListResponse> {
    const page = await this.notes.list({
      ownerId,
      limit: query.limit,
      cursor: query.cursor ?? null,
      search: query.q ?? null,
      pinned: query.pinned,
    });

    const last = page.items[page.items.length - 1];
    // A page that came back short is the last page; asking for another would return
    // nothing and make the caller render an empty "load more".
    const nextCursor =
      last === undefined || page.items.length < query.limit ? null : encodeCursor(last);

    return {
      items: page.items.map((note) => this.toResponse(note)),
      nextCursor,
      total: page.total,
    };
  }

  public async note(ownerId: string, id: string): Promise<NoteResponse> {
    const found = await this.notes.find(ownerId, id);
    if (found === null) throw new DomainException(appError('NOT_FOUND', 'Note not found'));
    return this.toResponse(found);
  }

  public async createNote(ownerId: string, input: CreateNoteRequest): Promise<NoteResponse> {
    const now = this.clock();
    const created = await this.notes.create({
      id: this.ids.next(),
      ownerId,
      // Derived, never accepted: a client-supplied title would be a second source of
      // truth for the same string, and the two would eventually disagree.
      title: noteTitleOf(input.body),
      body: input.body,
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now,
    });

    return this.toResponse(created);
  }

  public async updateNote(
    ownerId: string,
    id: string,
    input: UpdateNoteRequest,
  ): Promise<NoteResponse> {
    const existing = await this.notes.find(ownerId, id);
    if (existing === null) throw new DomainException(appError('NOT_FOUND', 'Note not found'));

    const updated = await this.notes.update(ownerId, id, {
      // The title is re-derived only when the body changed: a pin toggle must not
      // recompute it, because the same input would produce the same string and the write
      // would be wasted.
      ...(input.body === undefined ? {} : { body: input.body, title: noteTitleOf(input.body) }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    });

    if (updated === null) throw new DomainException(appError('NOT_FOUND', 'Note not found'));
    return this.toResponse(updated);
  }

  public async removeNote(ownerId: string, id: string): Promise<void> {
    const removed = await this.notes.remove(ownerId, id);
    if (!removed) throw new DomainException(appError('NOT_FOUND', 'Note not found'));
  }
}

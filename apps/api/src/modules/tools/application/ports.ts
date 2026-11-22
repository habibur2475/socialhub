/**
 * Tools ports.
 *
 * Notes are the only store: the other six tools are pure functions, so their "port" is the
 * kernel itself and an interface over it would be ceremony.
 *
 * The cursor is `<updatedAt ISO>|<id>` for the same reason the blog uses one — keyset
 * pagination stays correct while notes are being edited, which `OFFSET` does not.
 */

export type NoteRecord = {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly pinned: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type NoteListQuery = {
  readonly ownerId: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly search: string | null;
  readonly pinned: boolean | undefined;
};

export type NotePage = {
  readonly items: readonly NoteRecord[];
  readonly total: number;
};

export type NoteStore = {
  list(query: NoteListQuery): Promise<NotePage>;
  find(ownerId: string, id: string): Promise<NoteRecord | null>;
  create(record: NoteRecord): Promise<NoteRecord>;
  update(
    ownerId: string,
    id: string,
    patch: { readonly title?: string; readonly body?: string; readonly pinned?: boolean },
  ): Promise<NoteRecord | null>;
  remove(ownerId: string, id: string): Promise<boolean>;
};

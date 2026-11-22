/** Tools DTOs — aliases over the shared contracts, never redefinitions. */

import type {
  CreateNoteRequest,
  NoteListResponse,
  NoteQuery,
  NoteResponse,
  UpdateNoteRequest,
} from '@socialhub/contracts';

export {
  createNoteRequestSchema,
  noteQuerySchema,
  updateNoteRequestSchema,
} from '@socialhub/contracts';

export type CreateNoteDto = CreateNoteRequest;
export type UpdateNoteDto = UpdateNoteRequest;
export type NoteQueryDto = NoteQuery;
export type NoteDto = NoteResponse;
export type NoteListDto = NoteListResponse;

/**
 * Tools HTTP surface.
 *
 * Only notes are here. The route prefix is `/api/v1/tools` rather than `/api/v1/notes`
 * because the module is the tools module and a future tool that genuinely needs a server
 * joins it without a second prefix — but the resource underneath is notes and nothing else.
 *
 * Every route is owner-scoped: the account id comes from the bearer token and is never
 * accepted from the request, so there is no id to tamper with.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodBody, ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import type { ToolsService } from '../application/tools.service.js';
import { TOOLS_SERVICE } from '../tools.tokens.js';
import {
  createNoteRequestSchema,
  noteQuerySchema,
  updateNoteRequestSchema,
  type CreateNoteDto,
  type NoteDto,
  type NoteListDto,
  type NoteQueryDto,
  type UpdateNoteDto,
} from './dto.js';

@Controller({ path: 'tools/notes', version: '1' })
@UseGuards(AuthGuard)
export class ToolsController {
  public constructor(@Inject(TOOLS_SERVICE) private readonly tools: ToolsService) {}

  @Get()
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(noteQuerySchema)) query: NoteQueryDto,
  ): Promise<NoteListDto> {
    return this.tools.listNotes(principal.accountId, query);
  }

  @Get(':id')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<NoteDto> {
    return this.tools.note(principal.accountId, id);
  }

  @Post()
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createNoteRequestSchema)) body: CreateNoteDto,
  ): Promise<NoteDto> {
    return this.tools.createNote(principal.accountId, body);
  }

  @Patch(':id')
  public async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(updateNoteRequestSchema)) body: UpdateNoteDto,
  ): Promise<NoteDto> {
    return this.tools.updateNote(principal.accountId, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.tools.removeNote(principal.accountId, id);
  }
}

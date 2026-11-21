/**
 * Messaging HTTP surface.
 *
 * Every route requires authentication, and every route is scoped to the caller: there
 * is no way to name a thread you are not in, because the store's reads all pass
 * `can_view_conversation()`.
 *
 * A direct conversation is opened with `POST /messages/direct` and the *account* id,
 * not a thread id. The thread identity is derived from the unordered pair, so the same
 * request from either side converges on one conversation — which is what makes the
 * "message" button on a profile safe to press twice.
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
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodBody, ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import type { MessageView } from '@socialhub/contracts';
import type { MessagingService } from '../application/messaging.service.js';
import { MESSAGING_SERVICE } from '../messaging.tokens.js';
import {
  type AddMembersDto,
  type ConversationQueryDto,
  type CreateGroupDto,
  type MessageListDto,
  type OpenDirectDto,
  type SendMessageDto,
  type ThreadDto,
  type ThreadListDto,
  type UpdateGroupDto,
  addMembersRequestSchema,
  conversationQuerySchema,
  createGroupThreadRequestSchema,
  messageQuerySchema,
  openDirectThreadRequestSchema,
  sendMessageRequestSchema,
  updateGroupThreadRequestSchema,
} from './dto.js';
import type { MessageQuery } from '@socialhub/contracts';

@Controller('messages')
@UseGuards(AuthGuard)
export class MessagingController {
  public constructor(@Inject(MESSAGING_SERVICE) private readonly messaging: MessagingService) {}

  @Get('conversations')
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(conversationQuerySchema)) query: ConversationQueryDto,
  ): Promise<ThreadListDto> {
    return this.messaging.conversations(principal.accountId, {
      limit: query.limit,
      cursor: query.cursor ?? null,
      unreadOnly: query.unreadOnly,
    });
  }

  @Get('conversations/:id')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<ThreadDto> {
    return this.messaging.conversation(principal.accountId, id);
  }

  @Post('direct')
  public async openDirect(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(openDirectThreadRequestSchema)) body: OpenDirectDto,
  ): Promise<ThreadDto> {
    return this.messaging.openDirect(principal.accountId, body.accountId);
  }

  @Post('groups')
  public async createGroup(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createGroupThreadRequestSchema)) body: CreateGroupDto,
  ): Promise<ThreadDto> {
    return this.messaging.createGroup(principal.accountId, body);
  }

  @Post('conversations/:id/members')
  public async addMembers(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(addMembersRequestSchema)) body: AddMembersDto,
  ): Promise<ThreadDto> {
    return this.messaging.addMembers(principal.accountId, id, body);
  }

  @Delete('conversations/:id/members/me')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async leave(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.messaging.leave(principal.accountId, id);
  }

  @Post('conversations/:id')
  public async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(updateGroupThreadRequestSchema)) body: UpdateGroupDto,
  ): Promise<ThreadDto> {
    return this.messaging.updateGroup(principal.accountId, id, body);
  }

  @Get('conversations/:id/messages')
  public async messages(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Query(new ZodPipe(messageQuerySchema)) query: MessageQuery,
  ): Promise<MessageListDto> {
    return this.messaging.messages(principal.accountId, id, {
      limit: query.limit,
      before: query.before ?? null,
    });
  }

  @Post('conversations/:id/messages')
  public async send(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(sendMessageRequestSchema)) body: SendMessageDto,
  ): Promise<{ message: MessageView }> {
    return { message: await this.messaging.send(principal.accountId, id, body) };
  }

  /**
   * Marks the conversation read.
   *
   * `POST`, not `PATCH`: the operation is "advance my cursor to the newest message",
   * and the server decides which message that is. A client-supplied message id would
   * let a stale tab mark future messages read.
   */
  @Post('conversations/:id/read')
  public async read(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<{ unreadCount: number }> {
    return this.messaging.markRead(principal.accountId, id);
  }

  @Delete('conversations/:id/messages/:messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteMessage(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    await this.messaging.deleteMessage(principal.accountId, id, messageId);
  }
}

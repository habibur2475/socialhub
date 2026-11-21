/**
 * Messaging DTOs.
 *
 * Aliases over the shared contracts, so the composer in the browser and the validator
 * here cannot disagree about a body's maximum length or a cursor's shape.
 */

import type {
  AddMembersRequest,
  ConversationQuery,
  CreateGroupThreadRequest,
  MessageListResponse,
  OpenDirectThreadRequest,
  SendMessageRequest,
  ThreadListResponse,
  ThreadSummary,
  UpdateGroupThreadRequest,
} from '@socialhub/contracts';

export {
  addMembersRequestSchema,
  conversationQuerySchema,
  createGroupThreadRequestSchema,
  messageQuerySchema,
  openDirectThreadRequestSchema,
  sendMessageRequestSchema,
  updateGroupThreadRequestSchema,
} from '@socialhub/contracts';

export type OpenDirectDto = OpenDirectThreadRequest;
export type CreateGroupDto = CreateGroupThreadRequest;
export type UpdateGroupDto = UpdateGroupThreadRequest;
export type AddMembersDto = AddMembersRequest;
export type SendMessageDto = SendMessageRequest;
export type ConversationQueryDto = ConversationQuery;
export type ThreadDto = ThreadSummary;
export type ThreadListDto = ThreadListResponse;
export type MessageListDto = MessageListResponse;

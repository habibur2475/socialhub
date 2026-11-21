/**
 * Messaging use cases.
 *
 * The policy lives in the kernel (`decideDirectThread`, `decideSend`,
 * `prepareMessageBody`, `threadTitle`); this service assembles the facts those
 * functions need and refuses to write when they say no. Four consequences worth
 * stating:
 *
 * 1. **A refusal never says whether the other account exists.** "No relationship"
 *    and "blocked" both answer with the same status and the same sentence, because a
 *    stranger who can distinguish them can use the endpoint to enumerate accounts.
 * 2. **Sending is the only write on the hot path**, and it does two things after the
 *    insert: bump the thread summary (a trigger) and fan out a frame to every live
 *    participant. A failed count or a closed connection may not fail the send — the
 *    message is already stored, and the transcript is what the reader will see.
 * 3. **Messaging writes no notification rows.** The conversation *is* the inbox: a
 *    notification per message would duplicate it, and a mention inside a private
 *    conversation would tell a non-member that the conversation exists. The unread
 *    count on the thread is the badge, and it arrives on the same SSE stream.
 * 4. **The transcript is paged backwards.** `nextCursor` walks into the past, and the
 *    live tail arrives over the SSE connection rather than a poll.
 * 5. **Deleting is soft and owner-only.** The body is served as a placeholder, so a
 *    reply never loses the context it was answering.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  appError,
  decideDirectThread,
  decideSend,
  prepareMessageBody,
  threadTitle,
} from '@socialhub/kernel';
import type {
  AddMembersRequest,
  CreateGroupThreadRequest,
  MessageListResponse,
  MessageView,
  SendMessageRequest,
  ThreadListResponse,
  ThreadParticipant,
  ThreadSummary,
  UpdateGroupThreadRequest,
} from '@socialhub/contracts';

import { DomainException } from '../../../common/filters/domain-exception.js';
import { JsonLogger } from '../../../common/logging/logger.js';
import type { IdGenerator } from '../../auth/application/ports.js';
import { IDS } from '../../auth/auth.tokens.js';
import type { RealtimeHub } from '../../notifications/application/ports.js';
import { REALTIME_HUB } from '../../notifications/notifications.tokens.js';
import type {
  ConversationRecord,
  ConversationStore,
  MessageRecord,
  MessageParticipantRecord,
} from './ports.js';
import { CONVERSATION_STORE } from '../messaging.tokens.js';

/** What the transcript shows in place of a deleted message. */
export const DELETED_MESSAGE_PLACEHOLDER = 'This message was deleted';

/** The sentence used for every direct-thread refusal, blocked or not. */
const DIRECT_DENIAL = 'You cannot start a conversation with this account';

@Injectable()
export class MessagingService {
  public constructor(
    @Inject(CONVERSATION_STORE) private readonly store: ConversationStore,
    @Inject(REALTIME_HUB) private readonly hub: RealtimeHub,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Opens a direct conversation, or returns the one that already exists. */
  public async openDirect(viewerId: string, otherId: string): Promise<ThreadSummary> {
    if (viewerId === otherId) {
      throw new DomainException(appError('VALIDATION_FAILED', 'You cannot message yourself'));
    }

    const facts = await this.store.directPairFacts(viewerId, otherId);
    // An account that does not exist gets the same answer as one that cannot be
    // messaged: the difference is what makes account enumeration possible.
    if (facts === null) {
      throw new DomainException(appError('NOT_FOUND', DIRECT_DENIAL));
    }

    const decision = decideDirectThread({
      blocked: facts.blocked,
      senderFollowsRecipient: facts.senderFollowsRecipient,
      recipientFollowsSender: facts.recipientFollowsSender,
      threadExists: facts.threadId !== null,
    });

    if (!decision.allowed) {
      this.logger.event('info', 'messaging.direct_denied', {
        viewerId,
        reason: decision.reason,
      });
      throw new DomainException(appError('FORBIDDEN', DIRECT_DENIAL));
    }

    const conversation = await this.store.ensureDirectThread({
      id: facts.threadId ?? this.ids.next(),
      ownerId: viewerId,
      otherId,
    });

    return this.toSummary(conversation, viewerId);
  }

  public async createGroup(
    ownerId: string,
    input: CreateGroupThreadRequest,
  ): Promise<ThreadSummary> {
    if (input.memberIds.includes(ownerId)) {
      throw new DomainException(
        appError('VALIDATION_FAILED', 'You are already in a group you create'),
      );
    }

    await this.assertInvitables(ownerId, input.memberIds);

    const conversation = await this.store.createGroupThread({
      id: this.ids.next(),
      ownerId,
      title: input.title,
      memberIds: input.memberIds,
    });

    return this.toSummary(conversation, ownerId);
  }

  public async conversations(
    viewerId: string,
    page: { limit: number; cursor: string | null; unreadOnly: boolean },
  ): Promise<ThreadListResponse> {
    const result = await this.store.listConversations(viewerId, page);
    const items = result.items.map((conversation) => this.toSummary(conversation, viewerId));
    const last = result.items[result.items.length - 1];

    return {
      items,
      nextCursor:
        result.hasMore && last !== undefined
          ? `${last.lastMessageAt.toISOString()}|${last.id}`
          : null,
      unreadThreads: result.unreadThreads,
    };
  }

  public async conversation(viewerId: string, threadId: string): Promise<ThreadSummary> {
    const conversation = await this.store.findConversation(viewerId, threadId);
    // A block hides the thread from both sides, so "not found" is the honest answer
    // for a conversation the caller used to be in: there is nothing to tell them
    // about it that does not leak the other party's action.
    if (conversation === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }
    return this.toSummary(conversation, viewerId);
  }

  public async messages(
    viewerId: string,
    threadId: string,
    page: { limit: number; before: string | null },
  ): Promise<MessageListResponse> {
    const conversation = await this.store.findConversation(viewerId, threadId);
    if (conversation === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    const result = await this.store.listMessages(viewerId, threadId, page);
    const last = result.items[result.items.length - 1];

    return {
      // Stored newest-first for the keyset; the transcript renders oldest-first, so
      // the order is reversed once, here, rather than in every client.
      items: [...result.items].reverse().map(toMessageView),
      nextCursor: result.hasMore && last !== undefined ? last.id : null,
    };
  }

  public async send(
    senderId: string,
    threadId: string,
    input: SendMessageRequest,
  ): Promise<MessageView> {
    const draft = prepareMessageBody(input.body);
    if (!draft.allowed) {
      throw new DomainException(
        appError(
          'VALIDATION_FAILED',
          draft.reason === 'EMPTY' ? 'Write something first' : 'That message is too long',
        ),
      );
    }

    const facts = await this.store.sendFacts(threadId, senderId);
    // A blocked thread reports "not found" rather than "forbidden": the caller is
    // not entitled to know that the conversation still exists.
    if (facts === null || facts.blocked) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    const decision = decideSend({
      isMember: facts.isMember,
      locked: facts.locked,
      blocked: facts.blocked,
    });
    if (!decision.allowed) {
      if (decision.reason === 'NOT_A_MEMBER') {
        throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
      }
      throw new DomainException(appError('PRECONDITION_FAILED', 'This conversation is locked'));
    }

    const message = await this.store.appendMessage({
      id: this.ids.next(),
      threadId,
      senderId,
      body: draft.body,
      clientId: input.clientId ?? null,
    });

    const conversation = await this.store.findConversation(senderId, threadId);
    const recipients = (conversation?.participants ?? [])
      .filter((participant) => participant.leftAt === null)
      .map((participant) => participant.accountId)
      .filter((accountId) => accountId !== senderId);

    await this.fanOut({ conversation, message, recipients, senderId });

    return toMessageView(message);
  }

  public async markRead(viewerId: string, threadId: string): Promise<{ unreadCount: number }> {
    const conversation = await this.store.findConversation(viewerId, threadId);
    if (conversation === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    const latest = await this.store.listMessages(viewerId, threadId, { limit: 1, before: null });
    const newest = latest.items[0];
    // An empty conversation has no cursor to advance, and the badge is zero anyway.
    if (newest === undefined) return { unreadCount: 0 };

    const unreadCount = await this.store.markRead(viewerId, threadId, newest.id);
    this.hub.publish(viewerId, { type: 'thread-read', threadId, unreadCount });
    return { unreadCount };
  }

  public async updateGroup(
    viewerId: string,
    threadId: string,
    patch: UpdateGroupThreadRequest,
  ): Promise<ThreadSummary> {
    await this.requireOwner(viewerId, threadId);

    // `exactOptionalPropertyTypes` distinguishes an absent patch field from an
    // explicit `undefined`, so the two are copied over only when present.
    const updated = await this.store.updateGroup(viewerId, threadId, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.locked === undefined ? {} : { locked: patch.locked }),
    });
    if (updated === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    const summary = this.toSummary(updated, viewerId);
    this.publishToMembers(updated, viewerId, { type: 'thread', thread: summary });
    return summary;
  }

  public async addMembers(
    viewerId: string,
    threadId: string,
    input: AddMembersRequest,
  ): Promise<ThreadSummary> {
    const facts = await this.requireOwner(viewerId, threadId);

    const newcomers = input.memberIds.filter(
      (memberId) => !facts.participantIds.includes(memberId),
    );
    // The same rule as creation: a group cannot put two accounts that have blocked
    // each other into one room, whether at creation or later.
    await this.assertInvitables(viewerId, newcomers);

    const added = await this.store.addMembers({ threadId, memberIds: newcomers });

    const updated = await this.store.findConversation(viewerId, threadId);
    if (updated === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    // Only the newcomers are told: an existing member already knows the group exists,
    // and a frame per member would be a notification about nothing.
    for (const memberId of added) {
      this.hub.publish(memberId, { type: 'thread', thread: this.toSummary(updated, memberId) });
    }

    return this.toSummary(updated, viewerId);
  }

  public async leave(viewerId: string, threadId: string): Promise<void> {
    const conversation = await this.store.findConversation(viewerId, threadId);
    if (conversation === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }
    // Leaving a two-person conversation would leave one person talking to themselves
    // and would erase the other's history from their own view. Direct threads have no
    // leave — blocking is the operation there.
    if (conversation.kind !== 'GROUP') {
      throw new DomainException(
        appError('PRECONDITION_FAILED', 'A direct conversation cannot be left'),
      );
    }

    const removed = await this.store.removeMember(threadId, viewerId);
    if (!removed) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    const remaining = await this.store.findConversation(viewerId, threadId);
    if (remaining !== null) {
      this.publishToMembers(remaining, viewerId, {
        type: 'thread',
        thread: this.toSummary(remaining, viewerId),
      });
    }
  }

  public async deleteMessage(viewerId: string, threadId: string, messageId: string): Promise<void> {
    const conversation = await this.store.findConversation(viewerId, threadId);
    if (conversation === null) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }

    const deleted = await this.store.deleteMessage(threadId, messageId, viewerId);
    // Either the message is not the caller's, or it is already gone: both answer the
    // same way so a client cannot probe for other people's message ids.
    if (deleted === null) {
      throw new DomainException(appError('NOT_FOUND', 'Message not found'));
    }

    const view = toMessageView(deleted);
    for (const participant of conversation.participants) {
      if (participant.leftAt !== null) continue;
      this.hub.publish(participant.accountId, {
        type: 'message-deleted',
        threadId,
        messageId,
        message: view,
      });
    }
  }

  /**
   * Every invited account must exist and must not be blocked by, or blocking, the
   * inviter: a group is not a way to put two people who have blocked each other in the
   * same room.
   */
  private async assertInvitables(inviterId: string, memberIds: readonly string[]): Promise<void> {
    for (const memberId of memberIds) {
      if (memberId === inviterId) {
        throw new DomainException(appError('VALIDATION_FAILED', 'You are already in the group'));
      }
      const facts = await this.store.directPairFacts(inviterId, memberId);
      if (facts === null) {
        throw new DomainException(appError('VALIDATION_FAILED', 'One of those accounts is gone'));
      }
      if (facts.blocked) {
        throw new DomainException(
          appError('FORBIDDEN', 'You cannot add an account you have blocked or that blocked you'),
        );
      }
    }
  }

  private async requireOwner(viewerId: string, threadId: string) {
    const facts = await this.store.sendFacts(threadId, viewerId);
    if (facts === null || facts.blocked || !facts.isMember) {
      throw new DomainException(appError('NOT_FOUND', 'Conversation not found'));
    }
    if (facts.kind !== 'GROUP') {
      throw new DomainException(appError('PRECONDITION_FAILED', 'Only a group can be changed'));
    }
    if (facts.ownerId !== viewerId) {
      throw new DomainException(
        appError('FORBIDDEN', 'Only the owner of this group can change it'),
      );
    }
    return facts;
  }

  /**
   * Pushes the stored message to every live participant.
   *
   * Each recipient gets the frame with *their own* unread count, which is why this is
   * a loop over recipients rather than one broadcast: the count is per participant and
   * is the number the badge renders.
   */
  private async fanOut(input: {
    conversation: ConversationRecord | null;
    message: MessageRecord;
    recipients: readonly string[];
    senderId: string;
  }): Promise<void> {
    if (input.conversation === null) return;

    const view = toMessageView(input.message);
    const summaryForSender = this.toSummary(input.conversation, input.senderId);

    // The sender's other tabs need the message too; a send from a phone should appear
    // in an open browser window.
    this.hub.publish(input.senderId, {
      type: 'message',
      threadId: input.message.threadId,
      message: view,
      unreadCount: 0,
    });

    for (const recipientId of input.recipients) {
      const unreadCount = await this.store
        .unreadCount(recipientId, input.message.threadId)
        .catch((error: unknown) => {
          // The message is already stored; a failed count must not fail the send.
          this.logger.event('error', 'messaging.unread_count_failed', {
            threadId: input.message.threadId,
            message: error instanceof Error ? error.message : String(error),
          });
          return 0;
        });

      this.hub.publish(recipientId, {
        type: 'message',
        threadId: input.message.threadId,
        message: view,
        unreadCount,
        thread: this.toSummary(input.conversation, recipientId),
      });
    }

    // The sender's own list also changes: the thread moves to the top of their inbox.
    this.hub.publish(input.senderId, { type: 'thread', thread: summaryForSender });
  }

  private publishToMembers(conversation: ConversationRecord, except: string, frame: unknown): void {
    for (const participant of conversation.participants) {
      if (participant.leftAt !== null || participant.accountId === except) continue;
      this.hub.publish(participant.accountId, frame);
    }
  }

  private toSummary(conversation: ConversationRecord, viewerId: string): ThreadSummary {
    const live = conversation.participants.filter((participant) => participant.leftAt === null);
    const others = live.filter((participant) => participant.accountId !== viewerId);

    return {
      id: conversation.id,
      kind: conversation.kind,
      title: threadTitle({
        kind: conversation.kind,
        groupTitle: conversation.title,
        otherDisplayName: others[0]?.displayName ?? null,
        memberNames: others.map((participant) => participant.displayName),
      }),
      participants: conversation.participants.map(toParticipant),
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      lastMessagePreview: conversation.lastMessagePreview,
      unreadCount: conversation.unreadCount,
      locked: conversation.locked,
      viewerIsOwner: conversation.kind === 'GROUP' && conversation.ownerId === viewerId,
    };
  }
}

const toParticipant = (participant: MessageParticipantRecord): ThreadParticipant => ({
  accountId: participant.accountId,
  username: participant.username,
  displayName: participant.displayName,
  avatarKey: participant.avatarKey,
  owner: participant.owner,
});

const toMessageView = (message: MessageRecord): MessageView => ({
  id: message.id,
  threadId: message.threadId,
  sender: message.sender,
  // The body is never sent for a deleted message: the placeholder is rendered from
  // `deleted` by the client, and shipping the original text would defeat the delete.
  body: message.deleted ? DELETED_MESSAGE_PLACEHOLDER : message.body,
  deleted: message.deleted,
  createdAt: message.createdAt.toISOString(),
  clientId: message.clientId,
});

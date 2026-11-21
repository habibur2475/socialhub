/**
 * Forum use cases.
 *
 * Three rules, none of which is a technicality:
 *
 * 1. **A locked thread accepts no new answers.** Unpinning is reversible, so locking
 *    is how a moderator stops a thread that has gone wrong without deleting the
 *    conversation that already happened.
 * 2. **Only the thread's author may accept an answer, and only once.** Accepting is
 *    an endorsement, and an endorsement that anyone can give is not one.
 * 3. **Answers inherit the thread's visibility.** A block that hides a thread but
 *    not its answers leaks the conversation one level down.
 */

import { Inject, Injectable } from '@nestjs/common';
import { appError } from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';

import type {
  CreateAnswerRequest,
  CreateThreadRequest,
  ForumAnswerListResponse,
  ForumAnswerResponse,
  ForumAuthorResponse,
  ForumCategoryResponse,
  ForumThreadDetailResponse,
  ForumThreadListResponse,
  ForumThreadResponse,
  ForumThreadSummaryResponse,
} from '@socialhub/contracts';
import { FORUM_STORE } from '../forum.tokens.js';
import { NOTIFICATION_SERVICE } from '../../notifications/notifications.tokens.js';
import { PROFILE_STORE, SOCIAL_GRAPH_STORE } from '../../profile/profile.tokens.js';
import { IDS } from '../../auth/auth.tokens.js';
import type { NotificationsService } from '../../notifications/application/notifications.service.js';
import type { ProfileStore, SocialGraphStore } from '../../profile/application/ports.js';
import type { IdGenerator } from '../../auth/application/ports.js';
import type { ForumAnswerRecord, ForumStore, ForumThreadRecord } from './ports.js';

@Injectable()
export class ForumService {
  public constructor(
    @Inject(FORUM_STORE) private readonly forum: ForumStore,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationsService,
    @Inject(PROFILE_STORE) private readonly profiles: ProfileStore,
    @Inject(SOCIAL_GRAPH_STORE) private readonly graph: SocialGraphStore,
    @Inject(IDS) private readonly ids: IdGenerator,
  ) {}

  public async categories(): Promise<readonly ForumCategoryResponse[]> {
    const categories = await this.forum.listCategories();
    return categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      path: category.path,
      threadCount: category.threadCount,
    }));
  }

  public async listThreads(
    viewerId: string,
    page: { limit: number; cursor: string | null; category: string | null },
  ): Promise<ForumThreadListResponse> {
    const result = await this.forum.listThreads(viewerId, {
      limit: page.limit,
      cursor: page.cursor,
      categoryPath: page.category,
    });

    return {
      items: result.items.map(toSummary),
      nextCursor: result.hasMore ? (result.items[result.items.length - 1]?.id ?? null) : null,
    };
  }

  public async createThread(
    authorId: string,
    input: CreateThreadRequest,
  ): Promise<ForumThreadResponse> {
    // The category must exist before a thread can point at it, and the answer the
    // caller gets is a validation failure rather than a foreign-key error.
    const category = await this.forum.findCategoryById(input.categoryId);
    if (category === null) {
      throw new DomainException(appError('VALIDATION_FAILED', 'That category does not exist'));
    }

    const thread = await this.forum.createThread({
      id: this.ids.next(),
      categoryId: input.categoryId,
      authorId,
      title: input.title,
      body: input.body,
    });

    if (thread === null) {
      throw new DomainException(appError('INTERNAL_ERROR', 'The thread could not be created'));
    }

    return this.toThread(thread, authorId);
  }

  /** A thread and its first page of answers, in one response. */
  public async threadDetail(
    viewerId: string,
    threadId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ForumThreadDetailResponse> {
    const thread = await this.forum.findThread(viewerId, threadId);
    if (thread === null) throw new DomainException(appError('NOT_FOUND', 'Thread not found'));

    const answers = await this.forum.listAnswers(viewerId, threadId, page);

    return {
      thread: this.toThread(thread, viewerId),
      answers: answers.items.map((answer) => this.toAnswer(answer, viewerId)),
      nextCursor: answers.hasMore ? (answers.items[answers.items.length - 1]?.id ?? null) : null,
    };
  }

  public async answers(
    viewerId: string,
    threadId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ForumAnswerListResponse> {
    const thread = await this.forum.findThread(viewerId, threadId);
    if (thread === null) throw new DomainException(appError('NOT_FOUND', 'Thread not found'));

    const result = await this.forum.listAnswers(viewerId, threadId, page);
    return {
      items: result.items.map((answer) => this.toAnswer(answer, viewerId)),
      nextCursor: result.hasMore ? (result.items[result.items.length - 1]?.id ?? null) : null,
    };
  }

  public async createAnswer(
    authorId: string,
    threadId: string,
    input: CreateAnswerRequest,
  ): Promise<ForumAnswerResponse> {
    const thread = await this.forum.findThread(authorId, threadId);
    if (thread === null) throw new DomainException(appError('NOT_FOUND', 'Thread not found'));

    if (thread.locked) {
      throw new DomainException(appError('PRECONDITION_FAILED', 'This thread is locked'));
    }

    const answer = await this.forum.createAnswer({
      id: this.ids.next(),
      threadId,
      authorId,
      body: input.body,
    });

    // Null here means the conditional insert lost a race with a lock or a block;
    // both are reported as the same refusal the pre-check would have given.
    if (answer === null) {
      throw new DomainException(appError('PRECONDITION_FAILED', 'This thread cannot be answered'));
    }

    await this.notifyThreadAnswer(thread, answer, authorId);
    return this.toAnswer(answer, authorId);
  }

  public async acceptAnswer(
    accountId: string,
    threadId: string,
    answerId: string,
  ): Promise<ForumAnswerResponse> {
    const thread = await this.forum.findThread(accountId, threadId);
    if (thread === null) throw new DomainException(appError('NOT_FOUND', 'Thread not found'));

    // Only the author may accept: an endorsement anyone can give is not one. A
    // non-author gets NOT_FOUND rather than FORBIDDEN, since the thread itself is
    // readable and the only hidden fact would be *why* — which is not theirs.
    if (thread.authorId !== accountId) {
      throw new DomainException(appError('NOT_FOUND', 'Answer not found'));
    }

    const accepted = await this.forum.acceptAnswer({
      threadId,
      answerId,
      threadAuthorId: accountId,
    });

    if (accepted === null) {
      throw new DomainException(appError('NOT_FOUND', 'Answer not found'));
    }

    return this.toAnswer(accepted, accountId);
  }

  public async deleteAnswer(accountId: string, answerId: string): Promise<void> {
    const owner = await this.forum.answerOwner(answerId);
    if (owner === null) throw new DomainException(appError('NOT_FOUND', 'Answer not found'));

    // The answer's author, or the thread's author acting as moderator. Anyone else
    // is told the answer does not exist, which is also true from their perspective.
    const isThreadAuthor =
      owner.threadId !== null && (await this.forum.threadAuthorId(owner.threadId)) === accountId;
    if (owner.authorId !== accountId && !isThreadAuthor) {
      throw new DomainException(appError('NOT_FOUND', 'Answer not found'));
    }

    const removed = await this.forum.deleteAnswer(answerId, owner.authorId);
    if (!removed) throw new DomainException(appError('NOT_FOUND', 'Answer not found'));
  }

  /**
   * Notifies the thread's author that an answer arrived.
   *
   * Collapses per thread: a busy discussion is one notification that keeps bubbling
   * to the top, not one row per reply. Fire-and-forget — a missing notification must
   * never fail the answer that caused it.
   */
  private async notifyThreadAnswer(
    thread: ForumThreadRecord,
    answer: ForumAnswerRecord,
    actorId: string,
  ): Promise<void> {
    if (thread.authorId === actorId) return;

    const blocked = await this.graph.isBlockedEitherWay(thread.authorId, actorId).catch(() => true);

    await this.notifications
      .notify({
        kind: 'THREAD_ANSWER',
        recipientId: thread.authorId,
        actorId,
        groupKey: `thread-answer:${thread.id}`,
        subjectType: 'thread',
        subjectId: thread.id,
        preview: answer.body,
        context: { blocked, entitled: !blocked },
      })
      .catch(() => null);

    // Mention notifications are separate rows: the recipient and the subject differ
    // from the thread author's.
    await this.notifications
      .notifyMentions({
        body: answer.body,
        actorId,
        subjectType: 'thread',
        subjectId: thread.id,
        resolve: async (username) => {
          const profile = await this.profiles.findByUsername(username);
          return profile === null ? null : profile.accountId;
        },
        contextFor: async (recipientId) => {
          const blockedEither = await this.graph
            .isBlockedEitherWay(recipientId, actorId)
            .catch(() => true);
          return { blocked: blockedEither, entitled: !blockedEither };
        },
      })
      .catch(() => 0);
  }

  private toThread(thread: ForumThreadRecord, viewerId: string): ForumThreadResponse {
    const summary = toSummary(thread);

    return {
      ...summary,
      body: thread.body,
      // Synchronous best-effort: `canAccept` is derived from facts already loaded
      // for the summary, so no extra query is needed.
      canAcceptAnswer: thread.authorId === viewerId && !thread.locked && !thread.hasAcceptedAnswer,
    };
  }

  private toAnswer(answer: ForumAnswerRecord, viewerId: string): ForumAnswerResponse {
    return {
      id: answer.id,
      threadId: answer.threadId,
      author: toAuthor(answer.author),
      body: answer.body,
      accepted: answer.accepted,
      createdAt: answer.createdAt.toISOString(),
      canDelete: answer.authorId === viewerId,
    };
  }
}

const toAuthor = (author: ForumThreadRecord['author']): ForumAuthorResponse => ({
  accountId: author.accountId,
  username: author.username,
  displayName: author.displayName,
  avatarKey: author.avatarKey,
});

const toSummary = (thread: ForumThreadRecord): ForumThreadSummaryResponse => ({
  id: thread.id,
  categoryId: thread.categoryId,
  categoryPath: thread.categoryPath,
  title: thread.title,
  author: toAuthor(thread.author),
  answerCount: thread.answerCount,
  pinned: thread.pinned,
  locked: thread.locked,
  hasAcceptedAnswer: thread.hasAcceptedAnswer,
  // The list sorts by the thread's own id; `lastActivityAt` is the last time either
  // the thread or one of its answers changed, which is what a reader cares about.
  lastActivityAt: thread.updatedAt.toISOString(),
  createdAt: thread.createdAt.toISOString(),
});

/**
 * Blog use cases.
 *
 * The policy lives in the kernel (`prepareArticle`, `decideTransition`, `slugFor`,
 * `excerptOf`, `readingMinutes`, `normaliseTags`, `effectiveStatus`). This service
 * assembles what those functions need and refuses to write when they say no. Four
 * decisions worth stating:
 *
 * 1. **The excerpt and the reading time are computed once, at write time.** They are
 *    stored because a list of 20 articles must not read 20 bodies to render 20 previews,
 *    and they are computed here rather than in the database because the same function
 *    runs in the browser for the live preview while typing.
 * 2. **A slug collision is a `409`, not a silent suffix.** An author who chose a URL
 *    must not discover it was quietly changed to `-2`.
 * 3. **The status a reader sees is resolved through `effectiveStatus`.** A scheduled
 *    article that is already due reads as `PUBLISHED` in the summary, even though the
 *    stored column still says `SCHEDULED` — the row keeps the author's intent, the
 *    response tells the reader the truth.
 * 4. **Deleting is a real delete here, unlike a post.** An article has no replies and no
 *    likes; a soft-deleted article would be a URL that answers 404-shaped content rather
 *    than a URL that is gone.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  appError,
  decideTransition,
  effectiveStatus,
  excerptOf,
  hasUnbalancedFence,
  normaliseTags,
  prepareArticle,
  readingMinutes,
  slugFor,
} from '@socialhub/kernel';
import type {
  ArticleListResponse,
  ArticleQuery,
  ArticleResponse,
  ArticleSummaryResponse,
  ArticleTagListResponse,
  CreateArticleRequest,
  PublishArticleRequest,
  UpdateArticleRequest,
} from '@socialhub/contracts';

import { DomainException } from '../../../common/filters/domain-exception.js';
import type { Clock, IdGenerator } from '../../auth/application/ports.js';
import { CLOCK, IDS } from '../../auth/auth.tokens.js';
import type { ArticleRecord, ArticleStore } from './ports.js';
import { ARTICLE_STORE } from '../blog.tokens.js';

/** The sentence every `NOTHING_TO_PUBLISH` refusal shows. */
const INCOMPLETE = 'An article needs a title and a body before it can be published';

@Injectable()
export class BlogService {
  public constructor(
    @Inject(ARTICLE_STORE) private readonly store: ArticleStore,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async list(viewerId: string, query: ArticleQuery): Promise<ArticleListResponse> {
    const page = await this.store.list({
      viewerId,
      limit: query.limit,
      cursor: query.cursor ?? null,
      tag: query.tag ?? null,
      authorUsername: query.author ?? null,
      mine: query.mine,
      now: this.clock(),
    });

    const last = page.items[page.items.length - 1];
    const orderColumn = query.mine ? 'createdAt' : 'publishedAt';

    return {
      items: page.items.map((article) => this.toSummary(article, viewerId)),
      nextCursor:
        page.hasMore && last !== undefined
          ? `${(last[orderColumn] ?? last.createdAt).toISOString()}|${last.id}`
          : null,
    };
  }

  public async detail(viewerId: string, idOrSlug: string): Promise<ArticleResponse> {
    const article = await this.store.find(viewerId, idOrSlug);
    // A draft and a blocked article answer the same way: the caller is not entitled to
    // know which of the two it was.
    if (article === null) {
      throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    }

    return { ...this.toSummary(article, viewerId), body: article.body };
  }

  public async create(authorId: string, input: CreateArticleRequest): Promise<ArticleResponse> {
    const prepared = prepareArticle({ title: input.title, body: input.body });
    if (!prepared.allowed) {
      throw new DomainException(appError('VALIDATION_FAILED', this.messageFor(prepared.reason)));
    }

    // An odd number of fences is the one Markdown mistake that silently corrupts every
    // heading after it, so it is refused at write time rather than explained later.
    if (hasUnbalancedFence(prepared.body)) {
      throw new DomainException(
        appError('VALIDATION_FAILED', 'A code block is not closed — add the closing ```'),
      );
    }

    const id = this.ids.next();
    const slug = input.slug ?? slugFor(prepared.title, id.replaceAll('-', '').slice(-8));

    if (await this.store.slugTaken(slug)) {
      throw new DomainException(appError('CONFLICT', 'That URL is already taken'));
    }

    const tags = normaliseTags(input.tags ?? []);

    const article = await this.store.create({
      id,
      authorId,
      slug,
      title: prepared.title,
      body: prepared.body,
      excerpt: excerptOf(prepared.body),
      readingMinutes: readingMinutes(prepared.body),
      tags,
    });

    return { ...this.toSummary(article, authorId), body: article.body };
  }

  public async update(
    authorId: string,
    id: string,
    input: UpdateArticleRequest,
  ): Promise<ArticleResponse> {
    const existing = await this.store.find(authorId, id);
    if (existing === null) throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    this.assertAuthor(existing, authorId);

    // The title and body are re-validated together when either changes: `prepareArticle`
    // is the one rule that says what a complete article is, and validating only the field
    // that arrived would let an empty body through by editing the title alone.
    const title = input.title ?? existing.title;
    const body = input.body ?? existing.body;

    let preparedTitle: string | null = null;
    let preparedBody: string | null = null;
    let excerpt: string | null = null;
    let minutes: number | null = null;

    if (input.title !== undefined || input.body !== undefined) {
      const prepared = prepareArticle({ title, body });
      if (!prepared.allowed) {
        throw new DomainException(appError('VALIDATION_FAILED', this.messageFor(prepared.reason)));
      }
      if (hasUnbalancedFence(prepared.body)) {
        throw new DomainException(
          appError('VALIDATION_FAILED', 'A code block is not closed — add the closing ```'),
        );
      }

      preparedTitle = prepared.title;
      preparedBody = prepared.body;
      excerpt = excerptOf(prepared.body);
      minutes = readingMinutes(prepared.body);
    }

    if (input.slug !== undefined && input.slug !== existing.slug) {
      // Checked before the write so the answer is a `409` with a sentence, not a
      // constraint violation with a constraint name.
      if (await this.store.slugTaken(input.slug)) {
        throw new DomainException(appError('CONFLICT', 'That URL is already taken'));
      }
    }

    const updated = await this.store.update({
      id,
      authorId,
      slug: input.slug ?? null,
      title: preparedTitle,
      body: preparedBody,
      excerpt,
      readingMinutes: minutes,
      tags: input.tags === undefined ? null : normaliseTags(input.tags),
    });

    if (updated === null) throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    return { ...this.toSummary(updated, authorId), body: updated.body };
  }

  public async publish(
    authorId: string,
    id: string,
    input: PublishArticleRequest,
  ): Promise<ArticleResponse> {
    const existing = await this.store.find(authorId, id);
    if (existing === null) throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    this.assertAuthor(existing, authorId);

    const now = this.clock();
    const scheduledFor = input.scheduledFor === undefined ? null : new Date(input.scheduledFor);

    const decision = decideTransition({
      from: existing.status,
      to: input.status,
      // Completeness is the stored state, not the request's: a `PATCH` of the body that
      // emptied it cannot happen (the CHECK refuses it), so the row is the truth.
      complete: existing.title.trim().length > 0 && existing.body.trim().length > 0,
      scheduledFor,
      now,
    });

    if (!decision.allowed) {
      throw new DomainException(
        appError(this.codeFor(decision.reason), this.refusalFor(decision.reason)),
      );
    }

    // A schedule is a future moment and nothing else; every other transition clears it,
    // so a draft that was scheduled and then un-published carries no stale countdown.
    const storedSchedule = input.status === 'SCHEDULED' ? scheduledFor : null;

    /**
     * The publication date survives everything except scheduling.
     *
     * An archived article was published on the day it says, and a draft that was once
     * live keeps its date so that re-publishing it is a correction rather than a new
     * article at the top of the archive. Only a schedule clears it, because a scheduled
     * row has no publication date yet by definition.
     */
    const publishedAt =
      input.status === 'SCHEDULED' ? null : (decision.publishedAt ?? existing.publishedAt ?? now);

    const updated = await this.store.setStatus({
      id,
      authorId,
      status: input.status,
      publishedAt,
      scheduledFor: storedSchedule,
    });

    if (updated === null) throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    return { ...this.toSummary(updated, authorId), body: updated.body };
  }

  public async remove(authorId: string, id: string): Promise<void> {
    const existing = await this.store.find(authorId, id);
    if (existing === null) throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    this.assertAuthor(existing, authorId);

    const deleted = await this.store.delete(id, authorId);
    if (!deleted) throw new DomainException(appError('NOT_FOUND', 'Article not found'));
  }

  public async tags(): Promise<ArticleTagListResponse> {
    return { items: await this.store.listTags() };
  }

  /** Ownership is checked in code *and* in every statement's `WHERE author_id`. */
  private assertAuthor(article: ArticleRecord, authorId: string): void {
    if (article.authorId !== authorId) {
      // Not a `403`: telling a stranger that an article exists but is not theirs is the
      // disclosure that `NOT_FOUND` avoids.
      throw new DomainException(appError('NOT_FOUND', 'Article not found'));
    }
  }

  private toSummary(article: ArticleRecord, viewerId: string): ArticleSummaryResponse {
    const isAuthor = article.authorId === viewerId;

    return {
      id: article.id,
      slug: article.slug,
      title: article.title,
      excerpt: article.excerpt,
      readingMinutes: article.readingMinutes,
      tags: article.tags,
      author: article.author,
      // A due schedule reads as published; only the reader's answer matters here.
      status: effectiveStatus({
        status: article.status,
        publishedAt: article.publishedAt,
        scheduledFor: article.scheduledFor,
        now: this.clock(),
      }),
      publishedAt: article.publishedAt?.toISOString() ?? null,
      isAuthor,
      // Only the author is told when their own draft is due; to a reader it is either
      // readable or it does not exist.
      scheduledFor: isAuthor ? (article.scheduledFor?.toISOString() ?? null) : null,
      createdAt: article.createdAt.toISOString(),
      updatedAt: article.updatedAt.toISOString(),
    };
  }

  private messageFor(
    reason: 'EMPTY_TITLE' | 'TITLE_TOO_LONG' | 'EMPTY_BODY' | 'BODY_TOO_LONG',
  ): string {
    switch (reason) {
      case 'EMPTY_TITLE':
        return 'Give the article a title';
      case 'TITLE_TOO_LONG':
        return 'That title is too long';
      case 'EMPTY_BODY':
        return 'Write something first';
      case 'BODY_TOO_LONG':
        return 'That article is too long — split it';
    }
  }

  private codeFor(
    reason:
      | 'INVALID_TRANSITION'
      | 'NOTHING_TO_PUBLISH'
      | 'SCHEDULE_IN_THE_PAST'
      | 'SCHEDULE_WITHOUT_DATE',
  ): 'PRECONDITION_FAILED' | 'VALIDATION_FAILED' {
    // An illegal move is a state problem (the article is archived, already published);
    // a bad date is a bad input.
    return reason === 'INVALID_TRANSITION' || reason === 'NOTHING_TO_PUBLISH'
      ? 'PRECONDITION_FAILED'
      : 'VALIDATION_FAILED';
  }

  private refusalFor(
    reason:
      | 'INVALID_TRANSITION'
      | 'NOTHING_TO_PUBLISH'
      | 'SCHEDULE_IN_THE_PAST'
      | 'SCHEDULE_WITHOUT_DATE',
  ): string {
    switch (reason) {
      case 'INVALID_TRANSITION':
        return 'An archived article cannot be brought back';
      case 'NOTHING_TO_PUBLISH':
        return INCOMPLETE;
      case 'SCHEDULE_IN_THE_PAST':
        return 'Choose a moment in the future, or publish now';
      case 'SCHEDULE_WITHOUT_DATE':
        return 'Choose when this article should go live';
    }
  }
}

/**
 * Blog service rules.
 *
 * What the service decides rather than what the database enforces: which slug a title
 * becomes, that a collision is a conflict rather than a silent suffix, that the stored
 * excerpt and reading time come from the body that was written, and that every status
 * transition is refused with a code the UI can word. The database properties (slug
 * uniqueness, the schedule pairing, `can_view_article`) live in the schema and e2e suites.
 */

import { describe, expect, it, vi } from 'vitest';

import { BlogService } from './blog.service.js';
import type { ArticleRecord, ArticleStore } from './ports.js';
import type { ArticleStatus } from '@socialhub/kernel';

const AUTHOR = '0190f3c1-0000-7000-8000-00000000000a';
const OTHER = '0190f3c1-0000-7000-8000-00000000000b';
const ARTICLE = '0190f3c1-0000-7000-8000-0000000000d1';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const LATER = new Date('2026-04-01T09:00:00.000Z');

const article = (overrides: Partial<ArticleRecord> = {}): ArticleRecord => ({
  id: ARTICLE,
  authorId: AUTHOR,
  author: {
    accountId: AUTHOR,
    username: 'ada',
    displayName: 'Ada Lovelace',
    avatarKey: null,
    bio: null,
  },
  slug: 'a-perfectly-reasonable-title',
  title: 'A perfectly reasonable title',
  body: 'The body of the article.',
  excerpt: 'The body of the article.',
  readingMinutes: 1,
  tags: [],
  status: 'DRAFT',
  publishedAt: null,
  scheduledFor: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const createService = (
  options: {
    existing?: ArticleRecord | null;
    slugTaken?: boolean;
    returned?: ArticleRecord;
  } = {},
) => {
  const store = {
    list: vi.fn(async () => ({ items: [], hasMore: false })),
    find: vi.fn(async () => ('existing' in options ? options.existing : article())),
    slugTaken: vi.fn(async () => options.slugTaken ?? false),
    create: vi.fn(async () => options.returned ?? article()),
    update: vi.fn(async () => options.returned ?? article()),
    setStatus: vi.fn(async () => options.returned ?? article()),
    delete: vi.fn(async () => true),
    listTags: vi.fn(async () => []),
  } satisfies ArticleStore;

  const service = new BlogService(store, { next: () => ARTICLE }, () => NOW);

  return { service, store };
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ error: { code } });
};

describe('blog service: creating', () => {
  it('derives the slug, excerpt and reading time from what was written', async () => {
    const { service, store } = createService();

    await service.create(AUTHOR, {
      title: 'Shipping a Monorepo',
      body: '## Heading\n\nThe prose goes here.',
    });

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: AUTHOR,
        slug: 'shipping-a-monorepo',
        title: 'Shipping a Monorepo',
        excerpt: 'Heading The prose goes here.',
        readingMinutes: 1,
      }),
    );
  });

  it('normalises tags before storing them', async () => {
    const { service, store } = createService();
    await service.create(AUTHOR, {
      title: 'A real title',
      body: 'Body',
      tags: ['PostgreSQL', ' postgresql ', 'TypeScript'],
    });

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['postgresql', 'typescript'] }),
    );
  });

  /** An author who chose a URL must not discover it was quietly changed. */
  it('answers a slug collision with a conflict, not a suffixed slug', async () => {
    const { service, store } = createService({ slugTaken: true });

    await expectCode(
      service.create(AUTHOR, { title: 'A real title', body: 'Body', slug: 'taken-url' }),
      'CONFLICT',
    );
    expect(store.create).not.toHaveBeenCalled();
  });

  it('falls back to a uuid-derived slug for a title with no Latin characters', async () => {
    const { service, store } = createService();
    await service.create(AUTHOR, { title: 'বাংলায় লেখা', body: 'Body' });

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: expect.stringMatching(/^article-[0-9a-f]{8}$/) }),
    );
  });

  it('rejects an empty title, an empty body and an unclosed code fence', async () => {
    const { service, store } = createService();

    await expectCode(service.create(AUTHOR, { title: '   ', body: 'Body' }), 'VALIDATION_FAILED');
    await expectCode(
      service.create(AUTHOR, { title: 'A title', body: '   ' }),
      'VALIDATION_FAILED',
    );
    await expectCode(
      service.create(AUTHOR, { title: 'A title', body: 'Before\n```ts\nconst a = 1;' }),
      'VALIDATION_FAILED',
    );
    expect(store.create).not.toHaveBeenCalled();
  });
});

describe('blog service: editing', () => {
  it('refuses an article that is not the caller\u2019s, as not found', async () => {
    const { service } = createService({ existing: article({ authorId: OTHER }) });

    await expectCode(service.update(AUTHOR, ARTICLE, { title: 'Mine now' }), 'NOT_FOUND');
    await expectCode(service.publish(AUTHOR, ARTICLE, { status: 'PUBLISHED' }), 'NOT_FOUND');
    await expectCode(service.remove(AUTHOR, ARTICLE), 'NOT_FOUND');
  });

  /**
   * Editing the title alone re-validates the body too: `prepareArticle` is the one rule
   * that says what a complete article is, and a field-by-field check would let an empty
   * body through by touching the title.
   */
  it('re-validates the pair when only one field changes', async () => {
    const { service } = createService({ existing: article({ body: '   ' }) });

    await expectCode(
      service.update(AUTHOR, ARTICLE, { title: 'A new title' }),
      'VALIDATION_FAILED',
    );
  });

  it('recomputes the excerpt and reading time when the body changes', async () => {
    const { service, store } = createService();

    await service.update(AUTHOR, ARTICLE, { body: 'word '.repeat(200) });

    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        readingMinutes: 1,
        excerpt: expect.any(String),
      }),
    );
  });

  it('does not treat an unchanged slug as a collision with itself', async () => {
    const { service, store } = createService({ slugTaken: true });

    await service.update(AUTHOR, ARTICLE, { slug: article().slug });

    expect(store.update).toHaveBeenCalledWith(expect.objectContaining({ slug: article().slug }));
  });

  it('refuses a slug someone else owns', async () => {
    const { service } = createService({ slugTaken: true });
    await expectCode(service.update(AUTHOR, ARTICLE, { slug: 'someone-elses-url' }), 'CONFLICT');
  });
});

describe('blog service: publishing', () => {
  const publish = (status: ArticleStatus, existing: Partial<ArticleRecord> = {}) =>
    createService({ existing: article({ body: 'real prose', ...existing }) }).service.publish(
      AUTHOR,
      ARTICLE,
      { status },
    );

  it('publishes a draft and records the moment', async () => {
    const { service, store } = createService({ existing: article() });

    await service.publish(AUTHOR, ARTICLE, { status: 'PUBLISHED' });

    expect(store.setStatus).toHaveBeenCalledWith({
      id: ARTICLE,
      authorId: AUTHOR,
      status: 'PUBLISHED',
      publishedAt: NOW,
      scheduledFor: null,
    });
  });

  it('schedules for a future moment and clears the publication date', async () => {
    const { service, store } = createService({ existing: article() });

    await service.publish(AUTHOR, ARTICLE, {
      status: 'SCHEDULED',
      scheduledFor: LATER.toISOString(),
    });

    expect(store.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SCHEDULED', scheduledFor: LATER, publishedAt: null }),
    );
  });

  it('refuses a schedule in the past and one with no date', async () => {
    // No date at all: the kernel refuses it before any write.
    await expectCode(publish('SCHEDULED'), 'VALIDATION_FAILED');
    await expectCode(
      createService({ existing: article() }).service.publish(AUTHOR, ARTICLE, {
        status: 'SCHEDULED',
        scheduledFor: '2026-01-01T00:00:00.000Z',
      }),
      'VALIDATION_FAILED',
    );
  });

  it('refuses to resurrect an archived article', async () => {
    const { service } = createService({ existing: article({ status: 'ARCHIVED' }) });
    await expectCode(
      service.publish(AUTHOR, ARTICLE, { status: 'PUBLISHED' }),
      'PRECONDITION_FAILED',
    );
  });

  it('refuses to publish an article with no body', async () => {
    const { service } = createService({ existing: article({ body: '  ' }) });
    await expectCode(
      service.publish(AUTHOR, ARTICLE, { status: 'PUBLISHED' }),
      'PRECONDITION_FAILED',
    );
  });

  /** An archived article keeps the day it was published on. */
  it('keeps the publication date when archiving', async () => {
    const published = new Date('2026-01-05T08:00:00.000Z');
    const { service, store } = createService({
      existing: article({ status: 'PUBLISHED', publishedAt: published }),
    });

    await service.publish(AUTHOR, ARTICLE, { status: 'ARCHIVED' });

    expect(store.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ARCHIVED', publishedAt: published, scheduledFor: null }),
    );
  });
});

describe('blog service: reading', () => {
  it('reports a due schedule as published to a reader', async () => {
    const { service } = createService({
      existing: article({ status: 'SCHEDULED', scheduledFor: new Date('2026-02-01T00:00:00Z') }),
    });

    const detail = await service.detail(OTHER, ARTICLE);
    expect(detail.status).toBe('PUBLISHED');
  });

  /** A reader is never told when a draft is due; to them it is not there. */
  it('shows the schedule to the author and hides it from a reader', async () => {
    const scheduled = article({ status: 'SCHEDULED', scheduledFor: LATER });

    const asAuthor = await createService({ existing: scheduled }).service.detail(AUTHOR, ARTICLE);
    expect(asAuthor.scheduledFor).toBe(LATER.toISOString());
    expect(asAuthor.isAuthor).toBe(true);

    const asReader = await createService({ existing: scheduled }).service.detail(OTHER, ARTICLE);
    expect(asReader.scheduledFor).toBeNull();
    expect(asReader.isAuthor).toBe(false);
  });

  it('returns not found when the store cannot see the article', async () => {
    const { service } = createService({ existing: null });
    await expectCode(service.detail(OTHER, 'no-such-slug'), 'NOT_FOUND');
  });

  it('builds a cursor from the publication date for the archive, and the creation date for mine', async () => {
    const published = new Date('2026-02-02T00:00:00.000Z');
    const { service, store } = createService();

    store.list.mockResolvedValueOnce({
      items: [article({ status: 'PUBLISHED', publishedAt: published })],
      hasMore: true,
    });
    const archive = await service.list(OTHER, {
      limit: 20,
      mine: false,
    } as Parameters<typeof service.list>[1]);
    expect(archive.nextCursor).toBe(`${published.toISOString()}|${ARTICLE}`);

    store.list.mockResolvedValueOnce({ items: [article()], hasMore: true });
    const mine = await service.list(AUTHOR, {
      limit: 20,
      mine: true,
    } as Parameters<typeof service.list>[1]);
    expect(mine.nextCursor).toBe(`${NOW.toISOString()}|${ARTICLE}`);
  });
});

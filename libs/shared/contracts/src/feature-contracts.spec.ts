import { describe, expect, it } from 'vitest';

import {
  createQuizSetRequestSchema,
  submitQuizAttemptRequestSchema,
  quizSetQuerySchema,
} from './quiz.js';
import { createThreadRequestSchema, threadQuerySchema } from './forum.js';
import { notificationQuerySchema } from './notifications.js';
import {
  createGroupThreadRequestSchema,
  sendMessageRequestSchema,
  conversationQuerySchema,
  updateGroupThreadRequestSchema,
  MESSAGE_BODY_MAX_LENGTH,
} from './messaging.js';

const option = (label: string, correct: boolean) => ({ label, correct });

const validSet = {
  title: 'Algebra basics',
  questions: [
    {
      prompt: 'What is 2 + 2?',
      options: [option('4', true), option('5', false)],
    },
  ],
};

describe('quiz contracts', () => {
  it('accepts a minimal set and applies the documented defaults', () => {
    const parsed = createQuizSetRequestSchema.parse(validSet);
    expect(parsed.visibility).toBe('PUBLIC');
    // AUTO, because it is the only mode that can be graded without a human.
    expect(parsed.gradingMode).toBe('AUTO');
    expect(parsed.timeLimitSeconds).toBeUndefined();
  });

  it('rejects a question with no correct option', () => {
    const result = createQuizSetRequestSchema.safeParse({
      ...validSet,
      questions: [{ prompt: 'Anything?', options: [option('a', false), option('b', false)] }],
    });
    expect(result.success).toBe(false);
  });

  /** A question where every option is correct scores on any selection. */
  it('rejects a question where every option is correct', () => {
    const result = createQuizSetRequestSchema.safeParse({
      ...validSet,
      questions: [{ prompt: 'Anything?', options: [option('a', true), option('b', true)] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a single-option question and an empty set', () => {
    expect(
      createQuizSetRequestSchema.safeParse({
        ...validSet,
        questions: [{ prompt: 'One?', options: [option('only', true)] }],
      }).success,
    ).toBe(false);

    expect(createQuizSetRequestSchema.safeParse({ ...validSet, questions: [] }).success).toBe(
      false,
    );
  });

  it('enforces the time limit range', () => {
    // 29 seconds is below the floor that makes a timed attempt meaningful.
    expect(
      createQuizSetRequestSchema.safeParse({ ...validSet, timeLimitSeconds: 29 }).success,
    ).toBe(false);
    expect(
      createQuizSetRequestSchema.safeParse({ ...validSet, timeLimitSeconds: 86_401 }).success,
    ).toBe(false);
    expect(
      createQuizSetRequestSchema.safeParse({ ...validSet, timeLimitSeconds: 600 }).success,
    ).toBe(true);
  });

  it('trims titles and rejects blank ones', () => {
    expect(createQuizSetRequestSchema.parse({ ...validSet, title: '  Spaced  ' }).title).toBe(
      'Spaced',
    );
    expect(createQuizSetRequestSchema.safeParse({ ...validSet, title: '   ' }).success).toBe(false);
  });

  it('defaults a submitted answer to an empty selection', () => {
    const parsed = submitQuizAttemptRequestSchema.parse({
      answers: [{ questionId: '2f6a2b8e-6a1e-4f4a-9f2a-2f6a2b8e6a1e' }],
    });
    // A blank answer is a deliberate skip, not a malformed request.
    expect(parsed.answers[0]?.selectedOptionIds).toEqual([]);
  });

  it('coerces the list query and understands mine=true', () => {
    const parsed = quizSetQuerySchema.parse({ limit: '5', mine: 'true' });
    expect(parsed.limit).toBe(5);
    expect(parsed.mine).toBe(true);
    expect(quizSetQuerySchema.parse({ mine: 'false' }).mine).toBe(false);
  });
});

describe('forum contracts', () => {
  it('enforces the title length window', () => {
    expect(
      createThreadRequestSchema.safeParse({
        categoryId: '2f6a2b8e-6a1e-4f4a-9f2a-2f6a2b8e6a1e',
        title: 'ab',
        body: 'hello',
      }).success,
    ).toBe(false);

    // A title is trimmed before it is counted, so padding cannot buy length.
    const parsed = createThreadRequestSchema.parse({
      categoryId: '2f6a2b8e-6a1e-4f4a-9f2a-2f6a2b8e6a1e',
      title: '  A title  ',
      body: 'hello',
    });
    expect(parsed.title).toBe('A title');
  });

  it('accepts only a category path, not an id or a bare slug', () => {
    expect(threadQuerySchema.safeParse({ category: '/general/help' }).success).toBe(true);
    expect(threadQuerySchema.safeParse({ category: 'general' }).success).toBe(false);
    expect(threadQuerySchema.safeParse({ category: '/General' }).success).toBe(false);
  });
});

describe('notification contracts', () => {
  it('turns unreadOnly into a boolean, absent meaning false', () => {
    expect(notificationQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    // Absent means false, and the type is a plain boolean so no call site has to
    // distinguish "unset" from "false".
    expect(notificationQuerySchema.parse({}).unreadOnly).toBe(false);
  });

  it('rejects a cursor that is not a uuid', () => {
    expect(notificationQuerySchema.safeParse({ cursor: 'twenty' }).success).toBe(false);
  });
});

describe('messaging contracts', () => {
  const account = (suffix: number): string =>
    `0190f3c1-0000-7000-8000-${suffix.toString().padStart(12, '0')}`;

  const send = (body: string, clientId?: string) =>
    sendMessageRequestSchema.safeParse(clientId === undefined ? { body } : { body, clientId });

  /**
   * The kernel trims and then counts code points; the schema only enforces the
   * ceiling so the kernel's reason codes (`EMPTY`, `TOO_LONG`) stay the single
   * source of the user-facing message.
   */
  it('accepts a message at the limit and rejects one past it', () => {
    expect(send('a'.repeat(MESSAGE_BODY_MAX_LENGTH)).success).toBe(true);
    expect(send('a'.repeat(MESSAGE_BODY_MAX_LENGTH + 1)).success).toBe(false);
  });

  /** A blank body is left to the kernel, which reports it as `EMPTY`, not a parse error. */
  it('lets a whitespace-only body through to the domain check', () => {
    expect(send('   ').success).toBe(true);
  });

  it('requires clientId to be a uuid when present', () => {
    expect(send('hello', 'not-a-uuid').success).toBe(false);
    expect(send('hello', account(1)).success).toBe(true);
  });

  it('rejects a group with no name and a group with no other members', () => {
    expect(
      createGroupThreadRequestSchema.safeParse({ title: '  ', memberIds: [account(1)] }).success,
    ).toBe(false);
    expect(createGroupThreadRequestSchema.safeParse({ title: 'Team', memberIds: [] }).success).toBe(
      false,
    );
  });

  /**
   * Sending your own id is rejected rather than deduplicated: the creator is added
   * implicitly, so its presence means the client disagrees with the server about
   * who is in the conversation.
   */
  it('rejects duplicate members and an over-long title', () => {
    expect(
      createGroupThreadRequestSchema.safeParse({
        title: 'Team',
        memberIds: [account(1), account(1)],
      }).success,
    ).toBe(false);
    expect(
      createGroupThreadRequestSchema.safeParse({ title: 'x'.repeat(81), memberIds: [account(1)] })
        .success,
    ).toBe(false);
  });

  it('requires something to change in a group update', () => {
    expect(updateGroupThreadRequestSchema.safeParse({}).success).toBe(false);
    expect(updateGroupThreadRequestSchema.safeParse({ locked: true }).success).toBe(true);
  });

  /** `unreadOnly` arrives as a query string, so it must parse from 'true'/'false'. */
  it('coerces the unread filter from the query string', () => {
    expect(conversationQuerySchema.parse({}).unreadOnly).toBe(false);
    expect(conversationQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(conversationQuerySchema.parse({}).limit).toBe(20);
  });
});

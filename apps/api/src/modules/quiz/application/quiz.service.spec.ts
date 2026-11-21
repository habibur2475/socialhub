/**
 * Quiz service rules.
 *
 * The grader itself is tested in the kernel; these tests are about what this service
 * discloses and refuses: the answer key before grading, double submission, an
 * attempt that is not the caller's, and answers for questions that do not exist.
 */

import { describe, expect, it, vi } from 'vitest';

import { QuizService } from './quiz.service.js';
import type { QuizAttemptRecord, QuizSetDetail, QuizStore } from './ports.js';

const OWNER = '0190f3c1-0000-7000-8000-00000000000a';
const STUDENT = '0190f3c1-0000-7000-8000-00000000000b';

const OPTION_A = '0190f3c1-0000-7000-8000-0000000000a1';
const OPTION_B = '0190f3c1-0000-7000-8000-0000000000b1';
const QUESTION = '0190f3c1-0000-7000-8000-0000000000q1';
const SET = '0190f3c1-0000-7000-8000-0000000000s1';
const ATTEMPT = '0190f3c1-0000-7000-8000-0000000000t1';

const NOW = new Date('2026-01-01T10:00:00.000Z');

const set = (overrides: Partial<QuizSetDetail> = {}): QuizSetDetail => ({
  id: SET,
  ownerId: OWNER,
  owner: { accountId: OWNER, username: 'ada', displayName: 'Ada', avatarKey: null },
  title: 'Algebra',
  description: null,
  visibility: 'PUBLIC',
  gradingMode: 'AUTO',
  timeLimitSeconds: null,
  questionCount: 1,
  attemptCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  questions: [
    {
      id: QUESTION,
      prompt: 'What is 2 + 2?',
      position: 1,
      options: [
        { id: OPTION_A, label: '4', position: 1, isCorrect: true },
        { id: OPTION_B, label: '5', position: 2, isCorrect: false },
      ],
    },
  ],
  ...overrides,
});

const attempt = (overrides: Partial<QuizAttemptRecord> = {}): QuizAttemptRecord => ({
  id: ATTEMPT,
  setId: SET,
  accountId: STUDENT,
  startedAt: new Date('2026-01-01T09:55:00.000Z'),
  submittedAt: null,
  score: null,
  maxScore: null,
  answers: [],
  ...overrides,
});

const createService = (
  options: {
    detail?: QuizSetDetail | null;
    attempt?: QuizAttemptRecord | null;
    latest?: QuizAttemptRecord | null;
    submitted?: QuizAttemptRecord | null;
  } = {},
) => {
  const detail = options.detail === undefined ? set() : options.detail;
  const attemptRecord = options.attempt === undefined ? attempt() : options.attempt;

  const store: QuizStore = {
    create: vi.fn(async () => detail),
    findDetail: vi.fn(async () => detail),
    list: vi.fn(async () => ({ items: [], hasMore: false })),
    startAttempt: vi.fn(async () => attemptRecord),
    findAttempt: vi.fn(async () => attemptRecord),
    latestAttempt: vi.fn(async () => options.latest ?? null),
    submitAttempt: vi.fn(async (input: Parameters<QuizStore['submitAttempt']>[0]) =>
      options.submitted === undefined
        ? attempt({
            submittedAt: input.submittedAt,
            score: input.score,
            maxScore: input.maxScore,
            answers: input.answers,
          })
        : options.submitted,
    ),
    canView: vi.fn(async () => true),
  };

  let counter = 0;
  const ids = { next: (): string => `id-${++counter}` };

  return { service: new QuizService(store, ids, () => NOW), store };
};

const submission = (selectedOptionIds: string[]) => [{ questionId: QUESTION, selectedOptionIds }];

describe('reading a set', () => {
  /** A student who has not been graded could read the answers out of the payload. */
  it('redacts the answer key for a student who has not been graded', async () => {
    const { service } = createService();
    const view = await service.getSet(STUDENT, SET);

    expect(view.questions[0]?.options.map((option) => option.isCorrect)).toEqual([null, null]);
  });

  it('shows the key to the owner', async () => {
    const { service } = createService();
    const view = await service.getSet(OWNER, SET);

    expect(view.questions[0]?.options.map((option) => option.isCorrect)).toEqual([true, false]);
  });

  it('shows the key to a student whose attempt is graded', async () => {
    const { service } = createService({
      latest: attempt({ submittedAt: NOW, score: 1, maxScore: 1 }),
    });
    const view = await service.getSet(STUDENT, SET);

    expect(view.questions[0]?.options.map((option) => option.isCorrect)).toEqual([true, false]);
    expect(view.myAttempt?.score).toBe(1);
  });

  it('reports an invisible set as missing', async () => {
    const { service } = createService({ detail: null });
    await expect(service.getSet(STUDENT, SET)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('only advertises a next cursor when another page exists', async () => {
    const { service } = createService();
    expect(
      (await service.listSets(STUDENT, { limit: 20, cursor: null, mine: false })).nextCursor,
    ).toBeNull();
  });
});

describe('starting and submitting', () => {
  it('refuses to start an attempt on an invisible set', async () => {
    const { service, store } = createService();
    (store.startAttempt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(service.startAttempt(STUDENT, SET)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('grades a correct submission and explains every question', async () => {
    const { service } = createService();
    const result = await service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_A]));

    expect(result.score).toBe(1);
    expect(result.maxScore).toBe(1);
    expect(result.percentage).toBe(100);
    expect(result.results[0]).toEqual({
      questionId: QUESTION,
      selectedOptionIds: [OPTION_A],
      correctOptionIds: [OPTION_A],
      correct: true,
    });
  });

  it('grades a wrong submission as zero without throwing', async () => {
    const { service } = createService();
    const result = await service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_B]));

    expect(result.score).toBe(0);
    expect(result.results[0]?.correct).toBe(false);
  });

  /** A resubmit would let a student look up the answers and improve the score. */
  it('refuses to submit an already submitted attempt', async () => {
    const { service } = createService({
      attempt: attempt({ submittedAt: NOW, score: 0, maxScore: 1 }),
    });

    await expect(
      service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_A])),
    ).rejects.toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('reports a lost race on submit as a conflict, not a second grade', async () => {
    const { service } = createService({ submitted: null });
    await expect(
      service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_A])),
    ).rejects.toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('ignores answers for questions outside the set', async () => {
    const { service, store } = createService();
    await service.submitAttempt(STUDENT, ATTEMPT, [
      { questionId: QUESTION, selectedOptionIds: [OPTION_A] },
      { questionId: '0190f3c1-0000-7000-8000-0000000000ff', selectedOptionIds: [OPTION_B] },
    ]);

    const stored = (store.submitAttempt as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Parameters<QuizStore['submitAttempt']>[0];
    expect(stored.answers).toHaveLength(1);
  });

  it('reports a foreign attempt as missing', async () => {
    const { service } = createService({ attempt: null });
    await expect(
      service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_A])),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('marks a submission past the time limit as expired', async () => {
    const { service } = createService({
      detail: set({ timeLimitSeconds: 60 }),
      // Started 5 minutes before "now", with a 60-second limit.
      attempt: attempt({ startedAt: new Date('2026-01-01T09:55:00.000Z') }),
    });

    const result = await service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_A]));
    // Still graded: refusing it would leave a locked attempt nobody can grade.
    expect(result.score).toBe(1);
    expect(result.expired).toBe(true);
  });

  it('does not mark an untimed attempt as expired', async () => {
    const { service } = createService();
    const result = await service.submitAttempt(STUDENT, ATTEMPT, submission([OPTION_A]));
    expect(result.expired).toBe(false);
  });

  it('reports an unsubmitted attempt without a score', async () => {
    const { service } = createService();
    const result = await service.getAttempt(STUDENT, ATTEMPT);

    expect(result.score).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.submittedAt).toBeNull();
  });
});

describe('creating a set', () => {
  it('assigns ids to the set, its questions and its options', async () => {
    const { service, store } = createService();
    await service.createSet(OWNER, {
      title: 'Algebra',
      visibility: 'PUBLIC',
      gradingMode: 'AUTO',
      questions: [
        {
          prompt: 'What is 2 + 2?',
          options: [
            { label: '4', correct: true },
            { label: '5', correct: false },
          ],
        },
      ],
    });

    const created = (store.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Parameters<
      QuizStore['create']
    >[0];

    expect(created.questions).toHaveLength(1);
    expect(created.questions[0]?.options).toHaveLength(2);
    // Every id is generated server-side; a client-supplied id is a client-supplied
    // primary key.
    expect(created.questions[0]?.id).not.toBe(SET);
    expect(created.questions[0]?.options.every((option) => option.id.length > 0)).toBe(true);
  });
});

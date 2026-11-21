/**
 * Quiz contracts.
 *
 * Two decisions shape this file:
 *
 * 1. **A set is created whole.** Title, questions and options arrive in one
 *    request. A draft/resume workflow would need a second state machine and a
 *    "which questions are still unwritten" concept, and a quiz with six of ten
 *    questions is not a resource anyone wants half of. One request also means one
 *    transaction, so a set can never exist without its questions.
 *
 * 2. **The answer key is not in the public response.** `correctOptionIds` is
 *    stripped from a set the viewer has not been graded on — otherwise the client
 *    could read the answers out of the payload it is about to be tested on.
 */

import { z } from 'zod';

import { POST_VISIBILITIES } from './feed.js';

export const QUIZ_VISIBILITIES = POST_VISIBILITIES;

export const quizVisibilitySchema = z.enum(QUIZ_VISIBILITIES);

/** Mirrors the `quiz_sets.grading_mode` CHECK. */
export const QUIZ_GRADING_MODES = ['AUTO', 'MANUAL'] as const;

export const quizGradingModeSchema = z.enum(QUIZ_GRADING_MODES);

/** Mirrors `quiz_sets.time_limit_seconds`: 30 seconds to 24 hours, or untimed. */
export const QUIZ_TIME_LIMIT_MIN_SECONDS = 30;
export const QUIZ_TIME_LIMIT_MAX_SECONDS = 86_400;

export const QUIZ_TITLE_MAX_LENGTH = 120;
export const QUIZ_DESCRIPTION_MAX_LENGTH = 2_000;
export const QUIZ_QUESTION_MAX_LENGTH = 1_000;
export const QUIZ_OPTION_MAX_LENGTH = 500;

/** Hard ceilings, so one request cannot create a set nobody can render or grade. */
export const QUIZ_MAX_QUESTIONS = 100;
export const QUIZ_MAX_OPTIONS = 10;
export const QUIZ_MIN_OPTIONS = 2;

const optionSchema = z
  .object({
    label: z.string().trim().min(1, 'Every option needs a label').max(QUIZ_OPTION_MAX_LENGTH),
    /**
     * Called `correct` rather than `isCorrect` because that is what the author
     * thinks when writing it. The response uses `isCorrect` — see `optionResponse`
     * in the API — since there it is a fact about stored data, not an assertion.
     */
    correct: z.boolean(),
  })
  .strict();

const questionSchema = z
  .object({
    prompt: z.string().trim().min(1, 'Every question needs a prompt').max(QUIZ_QUESTION_MAX_LENGTH),
    options: z
      .array(optionSchema)
      .min(QUIZ_MIN_OPTIONS, `A question needs at least ${QUIZ_MIN_OPTIONS} options`)
      .max(QUIZ_MAX_OPTIONS),
  })
  .strict()
  .superRefine((question, context) => {
    const correct = question.options.filter((option) => option.correct).length;
    if (correct === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Mark at least one option correct',
      });
    }
    // Every option being correct makes the question unanswerable in practice: any
    // selection scores. That is a data error, not a teaching technique.
    if (correct === question.options.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Leave at least one option incorrect',
      });
    }
  });

export const createQuizSetRequestSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the set a title').max(QUIZ_TITLE_MAX_LENGTH),
    description: z.string().trim().max(QUIZ_DESCRIPTION_MAX_LENGTH).nullish(),
    visibility: quizVisibilitySchema.default('PUBLIC'),
    // AUTO is the default because it is the only mode the new attempt flow can
    // grade without a human, and a set that silently waits for a grader is worse.
    gradingMode: quizGradingModeSchema.default('AUTO'),
    timeLimitSeconds: z
      .number()
      .int()
      .min(QUIZ_TIME_LIMIT_MIN_SECONDS)
      .max(QUIZ_TIME_LIMIT_MAX_SECONDS)
      .nullish(),
    questions: z
      .array(questionSchema)
      .min(1, 'A set needs at least one question')
      .max(QUIZ_MAX_QUESTIONS),
  })
  .strict();

export type CreateQuizSetRequest = z.infer<typeof createQuizSetRequestSchema>;

/** One submitted answer: the option ids the student picked for a question. */
export const quizAnswerSchema = z
  .object({
    questionId: z.string().uuid(),
    /**
     * An empty array is a *deliberate* blank, and it is allowed: a student who
     * pressed submit without answering question 4 has to be able to say so. An
     * absent question means the same thing — the grader treats both as wrong.
     */
    selectedOptionIds: z.array(z.string().uuid()).max(QUIZ_MAX_OPTIONS).default([]),
  })
  .strict();

export const submitQuizAttemptRequestSchema = z
  .object({
    answers: z.array(quizAnswerSchema).max(QUIZ_MAX_QUESTIONS),
  })
  .strict();

export type SubmitQuizAttemptRequest = z.infer<typeof submitQuizAttemptRequestSchema>;

export const quizSetQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().uuid().optional(),
    /** Restrict to the caller's own sets, for the "my sets" view. */
    mine: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type QuizSetQuery = z.infer<typeof quizSetQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type QuizOptionResponse = {
  readonly id: string;
  readonly label: string;
  /**
   * Present only when the viewer may see the key: the owner, or a student whose
   * attempt has been graded. Null otherwise, and null rather than absent so the
   * field's presence does not itself leak whether an answer exists.
   */
  readonly isCorrect: boolean | null;
};

export type QuizQuestionResponse = {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly options: readonly QuizOptionResponse[];
};

export type QuizSetSummaryResponse = {
  readonly id: string;
  readonly owner: {
    readonly accountId: string;
    readonly username: string;
    readonly displayName: string;
    readonly avatarKey: string | null;
  };
  readonly title: string;
  readonly description: string | null;
  readonly visibility: (typeof QUIZ_VISIBILITIES)[number];
  readonly gradingMode: (typeof QUIZ_GRADING_MODES)[number];
  readonly timeLimitSeconds: number | null;
  readonly questionCount: number;
  readonly attemptCount: number;
  readonly createdAt: string;
};

export type QuizSetResponse = QuizSetSummaryResponse & {
  readonly questions: readonly QuizQuestionResponse[];
  /** The caller's latest attempt on this set, if any, so the UI can offer "resume". */
  readonly myAttempt: QuizAttemptResponse | null;
};

export type QuizAnswerResultResponse = {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly correctOptionIds: readonly string[];
  readonly correct: boolean;
};

export type QuizAttemptResponse = {
  readonly id: string;
  readonly setId: string;
  readonly startedAt: string;
  readonly submittedAt: string | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly percentage: number | null;
  /** True when a timed attempt ran past its limit and was graded as submitted. */
  readonly expired: boolean;
  /** Per-question detail. Empty until the attempt is submitted. */
  readonly results: readonly QuizAnswerResultResponse[];
};

export type QuizSetListResponse = {
  readonly items: readonly QuizSetSummaryResponse[];
  readonly nextCursor: string | null;
};

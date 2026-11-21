/**
 * Quiz ports.
 *
 * The store's job is to answer "what may this viewer see of this set", including
 * the answer key. That decision is in SQL (`can_view_quiz_set`) like every other
 * visibility rule, but the *key* is a second, finer question: the owner always sees
 * it, a student sees it only after their attempt is graded. Both facts are returned
 * per option rather than filtered here, because a page that omits fields is a page
 * whose shape changes — and a shape that changes leaks what was hidden.
 */

import type { QuizGradingMode, QuizVisibility } from '@socialhub/kernel';

export type QuizAuthor = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type QuizOptionRecord = {
  readonly id: string;
  readonly label: string;
  readonly position: number;
  /** Null when the viewer may not see the key. */
  readonly isCorrect: boolean | null;
};

export type QuizQuestionRecord = {
  readonly id: string;
  readonly prompt: string;
  readonly position: number;
  readonly options: readonly QuizOptionRecord[];
};

export type QuizSetRecord = {
  readonly id: string;
  readonly ownerId: string;
  readonly owner: QuizAuthor;
  readonly title: string;
  readonly description: string | null;
  readonly visibility: QuizVisibility;
  readonly gradingMode: QuizGradingMode;
  readonly timeLimitSeconds: number | null;
  readonly questionCount: number;
  readonly attemptCount: number;
  readonly createdAt: Date;
};

export type QuizSetDetail = QuizSetRecord & {
  readonly questions: readonly QuizQuestionRecord[];
};

export type QuizAttemptRecord = {
  readonly id: string;
  readonly setId: string;
  readonly accountId: string;
  readonly startedAt: Date;
  readonly submittedAt: Date | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  /** Stored per answer so a graded attempt can be re-explained without regrading. */
  readonly answers: readonly QuizAnswerRecord[];
};

export type QuizAnswerRecord = {
  readonly questionId: string;
  /**
   * The chosen options. Empty is a real answer — the student skipped the question —
   * and is stored as such rather than omitted, so a graded attempt can say "you left
   * this blank" instead of implying the question did not exist.
   */
  readonly selectedOptionIds: readonly string[];
};

export type QuizSetPage = {
  readonly items: readonly QuizSetRecord[];
  readonly hasMore: boolean;
};

export type QuizStore = {
  /** Inserts the set, its questions and its options in one transaction. */
  create(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly title: string;
    readonly description: string | null;
    readonly visibility: QuizVisibility;
    readonly gradingMode: QuizGradingMode;
    readonly timeLimitSeconds: number | null;
    readonly questions: readonly {
      readonly id: string;
      readonly prompt: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly correct: boolean;
      }[];
    }[];
  }): Promise<QuizSetDetail | null>;

  /** Returns null when the set is invisible to the viewer or does not exist. */
  findDetail(viewerId: string, setId: string): Promise<QuizSetDetail | null>;
  /** The summary list. Always filtered by `can_view_quiz_set`. */
  list(
    viewerId: string,
    page: { limit: number; cursor: string | null; mine: boolean },
  ): Promise<QuizSetPage>;

  /** Opens an attempt. Returns null when the viewer may not see the set. */
  startAttempt(input: {
    readonly id: string;
    readonly setId: string;
    readonly accountId: string;
  }): Promise<QuizAttemptRecord | null>;

  findAttempt(accountId: string, attemptId: string): Promise<QuizAttemptRecord | null>;
  latestAttempt(accountId: string, setId: string): Promise<QuizAttemptRecord | null>;

  /**
   * Stores the answers and the grade in one transaction.
   *
   * Returns null when the attempt is missing, not the caller's, or already
   * submitted — three cases the service reports as one NOT_FOUND/CONFLICT pair
   * rather than three distinguishable errors.
   */
  submitAttempt(input: {
    readonly attemptId: string;
    readonly accountId: string;
    readonly answers: readonly QuizAnswerRecord[];
    readonly score: number;
    readonly maxScore: number;
    readonly submittedAt: Date;
  }): Promise<QuizAttemptRecord | null>;

  /** True when the account may see the set at all. */
  canView(setId: string, viewerId: string): Promise<boolean>;
};

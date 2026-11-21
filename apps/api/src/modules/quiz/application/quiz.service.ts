/**
 * Quiz use cases.
 *
 * The grading rules live in the kernel (`gradeSubmission`, `attemptExpired`,
 * `canSubmitAttempt`); this service owns the ordering and the disclosure decisions:
 *
 *   1. **The answer key is stripped before the response is built.** A set read by a
 *      student who has not been graded carries `isCorrect: null` on every option —
 *      present and null, not absent, so the shape does not tell the reader that
 *      something was hidden.
 *   2. **An expired attempt is graded as submitted.** Refusing it at the boundary
 *      would leave a locked attempt nobody can grade; grading what was stored is
 *      honest and reproducible.
 *   3. **A set is graded against the questions as they are now.** Editing a set
 *      after an attempt started is refused by the store, not here, because the
 *      answer key and the questions are the same rows.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  appError,
  attemptExpired,
  canSubmitAttempt,
  gradeSubmission,
  type GradeResult,
  type QuizGradingMode,
  type QuizVisibility,
} from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';
import type { IdGenerator } from '../../auth/application/ports.js';
import { IDS } from '../../auth/auth.tokens.js';
import type { QuizAttemptRecord, QuizSetDetail, QuizStore } from './ports.js';
import { QUIZ_CLOCK, QUIZ_STORE } from '../quiz.tokens.js';
import type {
  CreateQuizSetRequest,
  QuizAnswerResultResponse,
  QuizAttemptResponse,
  QuizQuestionResponse,
  QuizSetListResponse,
  QuizSetResponse,
  QuizSetSummaryResponse,
} from '@socialhub/contracts';

export type Clock = () => Date;

@Injectable()
export class QuizService {
  public constructor(
    @Inject(QUIZ_STORE) private readonly sets: QuizStore,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(QUIZ_CLOCK) private readonly clock: Clock,
  ) {}

  // -------------------------------------------------------------------------
  // Sets
  // -------------------------------------------------------------------------

  public async createSet(ownerId: string, input: CreateQuizSetRequest): Promise<QuizSetResponse> {
    const created = await this.sets.create({
      id: this.ids.next(),
      ownerId,
      title: input.title,
      description: input.description ?? null,
      visibility: input.visibility,
      gradingMode: input.gradingMode,
      timeLimitSeconds: input.timeLimitSeconds ?? null,
      questions: input.questions.map((question) => ({
        id: this.ids.next(),
        prompt: question.prompt,
        options: question.options.map((option) => ({
          id: this.ids.next(),
          label: option.label,
          correct: option.correct,
        })),
      })),
    });

    if (created === null) {
      throw new DomainException(appError('INTERNAL_ERROR', 'The set could not be created'));
    }

    return this.toSetResponse(ownerId, created, null);
  }

  public async getSet(viewerId: string, setId: string): Promise<QuizSetResponse> {
    const set = await this.sets.findDetail(viewerId, setId);
    // A set the viewer may not see is reported as missing: two distinguishable
    // answers would confirm the existence of a private set.
    if (set === null) throw new DomainException(appError('NOT_FOUND', 'Quiz set not found'));

    const attempt = await this.sets.latestAttempt(viewerId, setId);
    return this.toSetResponse(viewerId, set, attempt);
  }

  public async listSets(
    viewerId: string,
    page: { limit: number; cursor: string | null; mine: boolean },
  ): Promise<QuizSetListResponse> {
    const result = await this.sets.list(viewerId, page);
    return {
      items: result.items.map((set) => this.toSummary(set)),
      nextCursor: result.hasMore ? (result.items[result.items.length - 1]?.id ?? null) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Attempts
  // -------------------------------------------------------------------------

  public async startAttempt(accountId: string, setId: string): Promise<QuizAttemptResponse> {
    const attempt = await this.sets.startAttempt({
      id: this.ids.next(),
      setId,
      accountId,
    });

    if (attempt === null) {
      // The insert is conditional on `can_view_quiz_set`, so a null here is either a
      // missing set or an invisible one — one answer, as everywhere else.
      throw new DomainException(appError('NOT_FOUND', 'Quiz set not found'));
    }

    return this.toAttemptResponse(attempt, null);
  }

  /**
   * Submits and grades an attempt.
   *
   * The submission is graded against the set as the *server* sees it, never against
   * what the client sent: a client that omits a question or invents an option id
   * gets the grade its stored answers earn, not the grade it asked for.
   */
  public async submitAttempt(
    accountId: string,
    attemptId: string,
    answers: readonly { questionId: string; selectedOptionIds: readonly string[] }[],
  ): Promise<QuizAttemptResponse> {
    const attempt = await this.sets.findAttempt(accountId, attemptId);
    if (attempt === null) throw new DomainException(appError('NOT_FOUND', 'Attempt not found'));

    if (!canSubmitAttempt(attempt.submittedAt, attempt.startedAt, this.clock())) {
      throw new DomainException(
        attempt.submittedAt === null
          ? appError('PRECONDITION_FAILED', 'This attempt has not started')
          : appError('CONFLICT', 'This attempt has already been submitted'),
      );
    }

    const set = await this.sets.findDetail(accountId, attempt.setId);
    if (set === null) throw new DomainException(appError('NOT_FOUND', 'Quiz set not found'));

    const questions = set.questions.map((question) => ({
      id: question.id,
      correctOptionIds: question.options
        .filter((option) => option.isCorrect === true)
        .map((option) => option.id),
    }));

    // Only answers for questions that exist are graded; an answer for a question
    // outside the set would otherwise silently count towards nothing.
    const known = new Set(questions.map((question) => question.id));
    const submitted = answers.filter((answer) => known.has(answer.questionId));

    const grade = gradeSubmission(questions, submitted);

    const submittedAt = this.clock();
    const stored = await this.sets.submitAttempt({
      attemptId,
      accountId,
      answers: submitted,
      score: grade.score,
      maxScore: grade.maxScore,
      submittedAt,
    });

    if (stored === null) {
      // The conditional update lost a race with another submit; the other one won,
      // and reporting a conflict is correct rather than overwriting its score.
      throw new DomainException(appError('CONFLICT', 'This attempt has already been submitted'));
    }

    return this.toAttemptResponse(stored, {
      grade,
      questions,
      // Derived at read time, never stored: a stored flag would disagree with the
      // clock the moment the owner changes the limit.
      expired: attemptExpired(attempt.startedAt, set.timeLimitSeconds, submittedAt),
    });
  }

  public async getAttempt(accountId: string, attemptId: string): Promise<QuizAttemptResponse> {
    const attempt = await this.sets.findAttempt(accountId, attemptId);
    if (attempt === null) throw new DomainException(appError('NOT_FOUND', 'Attempt not found'));

    // An unsubmitted attempt has no grade to explain; a submitted one is explained
    // from the stored answers, so the response is reproducible even after edits to
    // the set that are allowed to happen later.
    if (attempt.submittedAt === null) return this.toAttemptResponse(attempt, null);

    const set = await this.sets.findDetail(accountId, attempt.setId);
    if (set === null) throw new DomainException(appError('NOT_FOUND', 'Quiz set not found'));

    const questions = set.questions.map((question) => ({
      id: question.id,
      correctOptionIds: question.options
        .filter((option) => option.isCorrect === true)
        .map((option) => option.id),
    }));

    const grade = gradeSubmission(questions, attempt.answers);
    return this.toAttemptResponse(attempt, {
      grade,
      questions,
      expired: attemptExpired(attempt.startedAt, set.timeLimitSeconds, this.clock()),
    });
  }

  // -------------------------------------------------------------------------
  // Shaping
  // -------------------------------------------------------------------------

  /**
   * Builds the set response, deciding whether the key is visible.
   *
   * The rule is `answerKeyVisible` from the kernel: the owner always, a student only
   * once their attempt carries a score. `isCorrect` is set to null rather than
   * dropped, so a client can render locked options without a second shape.
   */
  private toSetResponse(
    viewerId: string,
    set: QuizSetDetail,
    attempt: QuizAttemptRecord | null,
  ): QuizSetResponse {
    const isOwner = set.ownerId === viewerId;
    const graded = attempt !== null && attempt.submittedAt !== null && attempt.score !== null;
    const showKey = isOwner || graded;

    const questions: QuizQuestionResponse[] = set.questions.map((question) => ({
      id: question.id,
      position: question.position,
      prompt: question.prompt,
      options: question.options.map((option) => ({
        id: option.id,
        label: option.label,
        // `null` is the redacted state, never `false`: a wrong-looking option in an
        // ungraded set would still tell a student which answer is not correct.
        isCorrect: showKey ? option.isCorrect === true : null,
      })),
    }));

    return {
      ...this.toSummary(set),
      questions,
      myAttempt: attempt === null ? null : this.toAttemptResponse(attempt, null),
    };
  }

  private toSummary(set: Omit<QuizSetDetail, 'questions'>): QuizSetSummaryResponse {
    return {
      id: set.id,
      owner: set.owner,
      title: set.title,
      description: set.description,
      visibility: set.visibility as QuizVisibility,
      gradingMode: set.gradingMode as QuizGradingMode,
      timeLimitSeconds: set.timeLimitSeconds,
      questionCount: set.questionCount,
      attemptCount: set.attemptCount,
      createdAt: set.createdAt.toISOString(),
    };
  }

  /**
   * Shapes an attempt.
   *
   * `expired` is computed from the set's limit and the attempt's own timestamps, so
   * it stays true after the fact. It is derived, not stored: a stored flag would
   * disagree with the clock the moment a limit is changed.
   */
  private toAttemptResponse(
    attempt: QuizAttemptRecord,
    detail: {
      readonly grade: GradeResult;
      readonly questions: readonly { id: string; correctOptionIds: readonly string[] }[];
      readonly expired: boolean;
    } | null,
  ): QuizAttemptResponse {
    const grade = detail?.grade ?? null;
    const questions = detail?.questions ?? [];
    const submitted = attempt.submittedAt !== null;
    const results: QuizAnswerResultResponse[] =
      grade === null || !submitted
        ? []
        : questions.map((question) => {
            const selected =
              attempt.answers.find((answer) => answer.questionId === question.id)
                ?.selectedOptionIds ?? [];
            const correct = grade.questions.find((entry) => entry.questionId === question.id);

            return {
              questionId: question.id,
              selectedOptionIds: selected,
              correctOptionIds: question.correctOptionIds,
              correct: correct?.correct ?? false,
            };
          });

    return {
      id: attempt.id,
      setId: attempt.setId,
      startedAt: attempt.startedAt.toISOString(),
      submittedAt: attempt.submittedAt === null ? null : attempt.submittedAt.toISOString(),
      score: attempt.score,
      maxScore: attempt.maxScore,
      percentage:
        attempt.score === null || attempt.maxScore === null || attempt.maxScore === 0
          ? null
          : Math.round((attempt.score / attempt.maxScore) * 100),
      expired: detail?.expired ?? false,
      results,
    };
  }
}

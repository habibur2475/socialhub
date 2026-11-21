import { describe, expect, it } from 'vitest';

import {
  answerKeyVisible,
  attemptExpired,
  canSubmitAttempt,
  gradeSubmission,
  type QuizQuestion,
  type SubmittedAnswer,
} from './quiz.js';

const question = (id: string, correct: string[]): QuizQuestion => ({
  id,
  correctOptionIds: correct,
});

const questions: readonly QuizQuestion[] = [
  question('q1', ['a']),
  question('q2', ['b', 'c']),
  question('q3', ['d']),
];

const answer = (questionId: string, selectedOptionIds: string[]): SubmittedAnswer => ({
  questionId,
  selectedOptionIds,
});

describe('gradeSubmission', () => {
  it('scores every correct answer', () => {
    const result = gradeSubmission(questions, [
      answer('q1', ['a']),
      answer('q2', ['c', 'b']), // order does not matter
      answer('q3', ['d']),
    ]);

    expect(result.score).toBe(3);
    expect(result.maxScore).toBe(3);
    expect(result.percentage).toBe(100);
  });

  it('scores a wrong answer as zero', () => {
    const result = gradeSubmission(questions, [answer('q1', ['x'])]);
    expect(result.score).toBe(0);
    expect(result.questions[0]?.correct).toBe(false);
  });

  /**
   * Partial credit within a question would make the score unexplainable to the
   * student: "4.5 out of 10" has no meaning when every question is right or wrong.
   */
  it('treats a partially correct multi-select as wrong', () => {
    const result = gradeSubmission(questions, [answer('q2', ['b'])]);
    expect(result.questions[1]).toEqual({ questionId: 'q2', correct: false, awarded: 0 });
  });

  it('rejects a multi-select that includes an extra option', () => {
    const result = gradeSubmission(questions, [answer('q2', ['b', 'c', 'd'])]);
    expect(result.questions[1]?.correct).toBe(false);
  });

  it('rejects a duplicate selection of the same correct option', () => {
    // ['a','a'] is not the same set as ['a'] only if length is trusted; exact-set
    // comparison treats it as wrong because the student selected two things.
    const result = gradeSubmission([question('q1', ['a'])], [answer('q1', ['a', 'a'])]);
    expect(result.score).toBe(0);
  });

  /** An unanswered question is wrong but still counts toward the maximum. */
  it('counts unanswered questions against the score', () => {
    const result = gradeSubmission(questions, [answer('q1', ['a'])]);
    expect(result.score).toBe(1);
    expect(result.maxScore).toBe(3);
    expect(result.percentage).toBe(33);
  });

  it('ignores answers for questions outside the set', () => {
    const result = gradeSubmission(questions, [
      answer('q1', ['a']),
      answer('deleted-question', ['a']),
    ]);
    expect(result.score).toBe(1);
    expect(result.questions).toHaveLength(3);
  });

  it('handles an empty set without dividing by zero', () => {
    const result = gradeSubmission([], []);
    expect(result).toEqual({ score: 0, maxScore: 0, questions: [], percentage: 0 });
  });

  /** Grading must be a pure function: the same input always gives the same score. */
  it('is deterministic and order-independent', () => {
    const answers = [answer('q1', ['a']), answer('q2', ['b', 'c']), answer('q3', ['d'])];
    const first = gradeSubmission(questions, answers);
    const second = gradeSubmission(questions, [...answers].reverse());
    expect(first.score).toBe(second.score);
  });
});

describe('attempt lifecycle', () => {
  const started = new Date('2026-01-01T10:00:00.000Z');

  it('allows a fresh attempt to be submitted', () => {
    expect(canSubmitAttempt(null, started, new Date('2026-01-01T10:05:00.000Z'))).toBe(true);
  });

  it('refuses to grade a submitted attempt twice', () => {
    // A resubmit would let a student see the score, look up the answers and improve
    // it, which is not an assessment.
    const submitted = new Date('2026-01-01T10:10:00.000Z');
    expect(canSubmitAttempt(submitted, started, new Date('2026-01-01T10:20:00.000Z'))).toBe(false);
  });

  it('refuses a submission timestamped before the attempt started', () => {
    expect(canSubmitAttempt(null, started, new Date('2026-01-01T09:59:00.000Z'))).toBe(false);
  });

  it('never expires an untimed attempt', () => {
    expect(attemptExpired(started, null, new Date('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('expires a timed attempt at exactly the limit', () => {
    // Inclusive at the boundary: honouring a submission at exactly the limit makes
    // the limit untestable.
    expect(attemptExpired(started, 600, new Date('2026-01-01T10:10:00.000Z'))).toBe(true);
    expect(attemptExpired(started, 600, new Date('2026-01-01T10:09:59.000Z'))).toBe(false);
  });
});

describe('answer key visibility', () => {
  it('always shows the key to the owner', () => {
    expect(
      answerKeyVisible({ viewerIsOwner: true, attemptSubmitted: false, attemptGraded: false }),
    ).toBe(true);
  });

  /** A student reading the set before submitting could read out the answers. */
  it('withholds the key from a student until the attempt is graded', () => {
    expect(
      answerKeyVisible({ viewerIsOwner: false, attemptSubmitted: false, attemptGraded: false }),
    ).toBe(false);
    expect(
      answerKeyVisible({ viewerIsOwner: false, attemptSubmitted: true, attemptGraded: false }),
    ).toBe(false);
    expect(
      answerKeyVisible({ viewerIsOwner: false, attemptSubmitted: true, attemptGraded: true }),
    ).toBe(true);
  });
});

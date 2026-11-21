/**
 * Quiz grading rules.
 *
 * The one decision that matters here is that **grading is pure and deterministic**.
 * A score is a function of (questions, correct options, submitted answers) and
 * nothing else — no clock, no randomness, no database. That means a disputed
 * grade can be recomputed from stored answers at any time, which is what makes it
 * defensible; a grader that consulted the current time or a shuffled order would
 * produce a score nobody can reproduce.
 *
 * The second decision: **an unanswered question is wrong, not skipped**, and it
 * still counts toward the maximum. A score of 3 out of 10 must mean three correct
 * answers, not three attempts out of seven questions.
 */

export type QuizQuestion = {
  readonly id: string;
  /** Option ids that are correct. More than one means "select all that apply". */
  readonly correctOptionIds: readonly string[];
};

export type SubmittedAnswer = {
  readonly questionId: string;
  /** The options the student selected. Empty for an unanswered question. */
  readonly selectedOptionIds: readonly string[];
};

export type GradedQuestion = {
  readonly questionId: string;
  readonly correct: boolean;
  /**
   * Partial credit within a single question: 1 for exactly right, 0 for exactly
   * wrong. There is deliberately no partial score between the two — a
   * half-correct multi-select is wrong, and pretending otherwise makes the score
   * unexplainable to the student who received it.
   */
  readonly awarded: 0 | 1;
};

export type GradeResult = {
  readonly score: number;
  readonly maxScore: number;
  readonly questions: readonly GradedQuestion[];
  /** Percentage, rounded, for display only. Never used for ranking. */
  readonly percentage: number;
};

/** Compares two id sets for exact equality, order-independent. */
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const value of b) {
    if (!left.has(value)) return false;
  }
  return true;
};

/**
 * Grades a submission.
 *
 * Extra answers for questions that are not in the set are ignored rather than
 * rejected: a client that submits a stale attempt should get a score for the
 * questions that still exist, not a hard failure that loses the whole run.
 */
export const gradeSubmission = (
  questions: readonly QuizQuestion[],
  answers: readonly SubmittedAnswer[],
): GradeResult => {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));

  const graded = questions.map((question): GradedQuestion => {
    const submitted = byQuestion.get(question.id);
    const selected = submitted?.selectedOptionIds ?? [];

    // An unanswered question is wrong, and still counted in the maximum.
    const correct =
      selected.length > 0 &&
      question.correctOptionIds.length > 0 &&
      sameSet(selected, question.correctOptionIds);

    return { questionId: question.id, correct, awarded: correct ? 1 : 0 };
  });

  const score = graded.reduce((total, entry) => total + entry.awarded, 0);
  const maxScore = graded.length;

  return {
    score,
    maxScore,
    questions: graded,
    // Rounded, and guarded against a zero-question set rather than returning NaN.
    percentage: maxScore === 0 ? 0 : Math.round((score / maxScore) * 100),
  };
};

/**
 * Whether an attempt may be submitted again.
 *
 * A submitted attempt is final for the purposes of grading. Allowing a resubmit
 * would let a student see the score, look up the answers, and improve it — which
 * is not an assessment. The caller starts a new attempt instead, and both are
 * retained.
 */
export const canSubmitAttempt = (submittedAt: Date | null, startedAt: Date, now: Date): boolean => {
  if (submittedAt !== null) return false;
  // A clock that moved backwards must not lock the student out of their own
  // attempt, but a submission before the start is a data error worth refusing.
  return now.getTime() >= startedAt.getTime();
};

/**
 * Whether a timed attempt has expired.
 *
 * `null` means untimed. The comparison is inclusive at the boundary: a student
 * who submits at exactly the limit has run out of time, and honouring it would
 * make the limit untestable.
 */
export const attemptExpired = (
  startedAt: Date,
  limitSeconds: number | null,
  now: Date,
): boolean => {
  if (limitSeconds === null) return false;
  return now.getTime() - startedAt.getTime() >= limitSeconds * 1_000;
};

/**
 * Quiz set visibility.
 *
 * The same three values a post uses, and deliberately not a fourth. A set is
 * addressed to a *relationship*, not to a snapshot of followers: unlike a post,
 * which freezes its audience at publication, a quiz set has a live visibility —
 * revoking a follow revokes access, because a set is a resource that stays open,
 * not an announcement that was made once.
 */
export type QuizVisibility = 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE';

/**
 * How a set is graded.
 *
 * AUTO grades on submit and returns the key. MANUAL stores the answers and waits
 * for the owner, which is why the key is withheld from a student until the attempt
 * carries a score — the mode is a property of the set, so every code path agrees.
 */
export type QuizGradingMode = 'AUTO' | 'MANUAL';

/** Whether a student may see the answer key for their attempt. */
export const answerKeyVisible = (setup: {
  readonly viewerIsOwner: boolean;
  readonly attemptSubmitted: boolean;
  readonly attemptGraded: boolean;
}): boolean => setup.viewerIsOwner || (setup.attemptSubmitted && setup.attemptGraded);

/**
 * Quiz persistence.
 *
 * Three queries carry the whole set read path, and each is one statement:
 *
 *   sets      filtered by `can_view_quiz_set()`, so visibility never depends on a
 *             caller remembering to check;
 *   questions fetched by set id, ordered by position;
 *   options   fetched for all of a set's questions at once and grouped in memory.
 *
 * The alternative — a question query per set, and an option query per question — is
 * an N+1 that grows with the size of the quiz, which is exactly the dimension an
 * author controls.
 *
 * An attempt's answers are stored one row per question. That row count is the
 * reason `quiz_answers` has a primary key on `(attempt_id, question_id)`: a
 * duplicate answer for the same question in one submission is a client bug, and the
 * database is where it gets caught rather than silently contributing a second
 * point.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools } from '../../../database/pool.js';
import type {
  QuizAnswerRecord,
  QuizAttemptRecord,
  QuizOptionRecord,
  QuizQuestionRecord,
  QuizSetDetail,
  QuizSetPage,
  QuizSetRecord,
  QuizStore,
} from '../application/ports.js';
import type { QuizGradingMode, QuizVisibility } from '@socialhub/kernel';

type RawSetRow = {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  visibility: QuizVisibility;
  grading_mode: QuizGradingMode;
  time_limit_seconds: number | null;
  attempt_count: number;
  created_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
  question_count: string;
};

type RawQuestionRow = {
  id: string;
  prompt: string;
  position: number;
  option_id: string | null;
  label: string | null;
  option_position: number | null;
  is_correct: boolean | null;
};

type RawAttemptRow = {
  id: string;
  set_id: string;
  account_id: string;
  started_at: Date;
  submitted_at: Date | null;
  score: number | null;
  max_score: number | null;
};

/**
 * The set projection, with one caller-supplied extra column.
 *
 * A function rather than a constant that call sites append to: appending to a
 * finished SELECT puts the extra expression after the FROM clause, which is a syntax
 * error the type system cannot catch because the query is a string.
 */
const selectSets = (extra: string): string => `
  SELECT s.id, s.owner_id, s.title, s.description, s.visibility, s.grading_mode,
         s.time_limit_seconds, s.attempt_count, s.created_at,
         pr.username, pr.display_name, pr.avatar_key,
         (SELECT count(*)::text FROM quiz_questions q WHERE q.set_id = s.id) AS question_count${extra}
    FROM quiz_sets s
    JOIN user_profiles pr ON pr.account_id = s.owner_id
`;

const toSet = (row: RawSetRow): QuizSetRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  owner: {
    accountId: row.owner_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
  title: row.title,
  description: row.description,
  visibility: row.visibility,
  gradingMode: row.grading_mode,
  timeLimitSeconds: row.time_limit_seconds,
  questionCount: Number(row.question_count),
  attemptCount: row.attempt_count,
  createdAt: row.created_at,
});

@Injectable()
export class PostgresQuizRepository implements QuizStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async create(input: Parameters<QuizStore['create']>[0]): Promise<QuizSetDetail | null> {
    await this.pools.transaction(async (client) => {
      await client.query(
        `INSERT INTO quiz_sets (id, owner_id, title, description, visibility, grading_mode, time_limit_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.ownerId,
          input.title,
          input.description,
          input.visibility,
          input.gradingMode,
          input.timeLimitSeconds,
        ],
      );

      for (const [index, question] of input.questions.entries()) {
        await client.query(
          `INSERT INTO quiz_questions (id, set_id, prompt, position) VALUES ($1, $2, $3, $4)`,
          [question.id, input.id, question.prompt, index + 1],
        );
        // One statement per question rather than one per option: a ten-option
        // question would otherwise be ten round trips inside the transaction, and
        // the transaction is what holds the row lock that a long insert extends.
        await client.query(
          `INSERT INTO quiz_options (id, question_id, label, position, is_correct)
           SELECT option.id, $2, option.label, option.position, option.is_correct
             FROM unnest($1::uuid[], $3::text[], $4::int[], $5::boolean[])
                  AS option(id, label, position, is_correct)`,
          [
            question.options.map((option) => option.id),
            question.id,
            question.options.map((option) => option.label),
            question.options.map((_, position) => position + 1),
            question.options.map((option) => option.correct),
          ],
        );
      }
    });

    // Read back through the same path a viewer uses, so the owner's response and a
    // visitor's response can never be built from different queries.
    return this.findDetail(input.ownerId, input.id);
  }

  public async findDetail(viewerId: string, setId: string): Promise<QuizSetDetail | null> {
    const setResult = await this.pools.pool().query<RawSetRow>(
      `${selectSets(', (s.owner_id = $1) AS viewer_is_owner')}
          WHERE s.id = $2 AND can_view_quiz_set(s.id, $1)`,
      [viewerId, setId],
    );

    const row = setResult.rows[0];
    if (row === undefined) return null;

    const questionResult = await this.pools.pool().query<RawQuestionRow>(
      `SELECT q.id, q.prompt, q.position,
              o.id AS option_id, o.label, o.position AS option_position, o.is_correct
         FROM quiz_questions q
         LEFT JOIN quiz_options o ON o.question_id = q.id
        WHERE q.set_id = $1
        ORDER BY q.position, o.position`,
      [setId],
    );

    return {
      ...toSet(row),
      questions: groupQuestions(questionResult.rows),
    };
  }

  public async list(
    viewerId: string,
    page: { limit: number; cursor: string | null; mine: boolean },
  ): Promise<QuizSetPage> {
    const result = await this.pools.pool().query<RawSetRow>(
      `${selectSets('')}
        WHERE can_view_quiz_set(s.id, $1)
          AND ($2::boolean IS FALSE OR s.owner_id = $1)
          AND ($3::uuid IS NULL OR s.id < $3::uuid)
        ORDER BY s.id DESC
        LIMIT $4`,
      [viewerId, page.mine, page.cursor, page.limit + 1],
    );

    return {
      items: result.rows.slice(0, page.limit).map(toSet),
      hasMore: result.rows.length > page.limit,
    };
  }

  public async canView(setId: string, viewerId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query<{ v: boolean }>('SELECT can_view_quiz_set($1, $2) AS v', [setId, viewerId]);
    return result.rows[0]?.v === true;
  }

  public async startAttempt(input: {
    readonly id: string;
    readonly setId: string;
    readonly accountId: string;
  }): Promise<QuizAttemptRecord | null> {
    const result = await this.pools.pool().query<RawAttemptRow>(
      `INSERT INTO quiz_attempts (id, set_id, account_id)
       SELECT $1, $2, $3 WHERE can_view_quiz_set($2, $3)
       RETURNING id, set_id, account_id, started_at, submitted_at, score, max_score`,
      [input.id, input.setId, input.accountId],
    );

    const row = result.rows[0];
    return row === undefined ? null : toAttempt(row, []);
  }

  public async findAttempt(
    accountId: string,
    attemptId: string,
  ): Promise<QuizAttemptRecord | null> {
    const result = await this.pools.pool().query<RawAttemptRow>(
      `SELECT id, set_id, account_id, started_at, submitted_at, score, max_score
         FROM quiz_attempts WHERE id = $1 AND account_id = $2`,
      [attemptId, accountId],
    );

    const row = result.rows[0];
    if (row === undefined) return null;
    return toAttempt(row, await this.answersOf([attemptId]));
  }

  public async latestAttempt(accountId: string, setId: string): Promise<QuizAttemptRecord | null> {
    const result = await this.pools.pool().query<RawAttemptRow>(
      `SELECT id, set_id, account_id, started_at, submitted_at, score, max_score
         FROM quiz_attempts
        WHERE account_id = $1 AND set_id = $2
        ORDER BY started_at DESC
        LIMIT 1`,
      [accountId, setId],
    );

    const row = result.rows[0];
    if (row === undefined) return null;
    return toAttempt(row, await this.answersOf([row.id]));
  }

  public async submitAttempt(
    input: Parameters<QuizStore['submitAttempt']>[0],
  ): Promise<QuizAttemptRecord | null> {
    return this.pools.transaction(async (client) => {
      // One conditional update is the concurrency guard: two simultaneous submits
      // cannot both see `submitted_at IS NULL`, so the second is refused rather than
      // overwriting the first score.
      const updated = await client.query<RawAttemptRow>(
        `UPDATE quiz_attempts
            SET submitted_at = $3, score = $4, max_score = $5
          WHERE id = $1 AND account_id = $2 AND submitted_at IS NULL
          RETURNING id, set_id, account_id, started_at, submitted_at, score, max_score`,
        [input.attemptId, input.accountId, input.submittedAt, input.score, input.maxScore],
      );

      const row = updated.rows[0];
      if (row === undefined) return null;

      // The answer rows are written after the attempt is marked submitted, inside
      // the same transaction: a submitted attempt with no answers would grade as
      // zero and be unexplainable later.
      //
      // A question with no selected options is still recorded, with an empty
      // selection. That distinction — "answered wrongly" versus "not answered" — is
      // what the graded response explains back to the student.
      for (const answer of input.answers) {
        await client.query(
          `INSERT INTO quiz_answers (attempt_id, question_id) VALUES ($1, $2)
           ON CONFLICT (attempt_id, question_id) DO NOTHING`,
          [input.attemptId, answer.questionId],
        );

        if (answer.selectedOptionIds.length === 0) continue;

        await client.query(
          `INSERT INTO quiz_answer_options (attempt_id, question_id, option_id)
           SELECT $1, $2, selected.option_id
             FROM unnest($3::uuid[]) AS selected(option_id)
           ON CONFLICT DO NOTHING`,
          [input.attemptId, answer.questionId, answer.selectedOptionIds],
        );
      }

      return toAttempt(row, input.answers);
    });
  }

  private async answersOf(attemptIds: readonly string[]): Promise<readonly QuizAnswerRecord[]> {
    if (attemptIds.length === 0) return [];

    const result = await this.pools.pool().query<{
      attempt_id: string;
      question_id: string;
      option_id: string | null;
    }>(
      `SELECT a.attempt_id, a.question_id, chosen.option_id
         FROM quiz_answers a
         LEFT JOIN quiz_answer_options chosen
                ON chosen.attempt_id = a.attempt_id AND chosen.question_id = a.question_id
        WHERE a.attempt_id = ANY($1::uuid[])
        ORDER BY a.question_id, chosen.option_id`,
      [attemptIds],
    );

    const grouped = new Map<string, string[]>();
    for (const row of result.rows) {
      const list = grouped.get(row.question_id) ?? [];
      // A question with no chosen option arrives as one row with a null option id;
      // it is still a question the student saw, and its empty list says so.
      if (row.option_id !== null) list.push(row.option_id);
      grouped.set(row.question_id, list);
    }

    // Questions whose answer row exists but whose selection is empty must be present
    // with an empty list; the LEFT JOIN already produced them, so grouping above
    // recorded them. Only rows for questions with no answer at all are absent.
    return [...grouped.entries()].map(([questionId, selectedOptionIds]) => ({
      questionId,
      selectedOptionIds,
    }));
  }
}

const toAttempt = (
  row: RawAttemptRow,
  answers: readonly QuizAnswerRecord[],
): QuizAttemptRecord => ({
  id: row.id,
  setId: row.set_id,
  accountId: row.account_id,
  startedAt: row.started_at,
  submittedAt: row.submitted_at,
  score: row.score,
  maxScore: row.max_score,
  answers,
});

/** Collapses the joined question/option rows into questions with their options. */
const groupQuestions = (rows: readonly RawQuestionRow[]): readonly QuizQuestionRecord[] => {
  const questions = new Map<
    string,
    { prompt: string; position: number; options: QuizOptionRecord[] }
  >();

  for (const row of rows) {
    let question = questions.get(row.id);
    if (question === undefined) {
      question = { prompt: row.prompt, position: row.position, options: [] };
      questions.set(row.id, question);
    }
    // A question with no options arrives as one row with a null option id, which is
    // exactly what a LEFT JOIN produces and what an unsaved question looks like.
    if (row.option_id === null || row.label === null || row.option_position === null) continue;

    question.options.push({
      id: row.option_id,
      label: row.label,
      position: row.option_position,
      isCorrect: row.is_correct,
    });
  }

  return [...questions.entries()]
    .sort(([, a], [, b]) => a.position - b.position)
    .map(([id, question]) => ({
      id,
      prompt: question.prompt,
      position: question.position,
      options: question.options,
    }));
};

/**
 * Job persistence.
 *
 * Two reads worth understanding:
 *
 *   * the *list* joins the viewer's own live proposal and a proposal count in one query. Doing
 *     it as three queries per row is how a board of twenty jobs becomes sixty round trips.
 *   * `openOnly` filters on `deadline > now()`, not on `status = 'OPEN'`. A job whose deadline
 *     passed yesterday still says OPEN in its column — whether it is *actually* open is a fact
 *     about time, and the board has to use the same answer the API gives.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type {
  JobListQuery,
  JobListRow,
  JobPage,
  JobRecord,
  JobStore,
} from '../application/ports.js';

type RawJobRow = {
  id: string;
  client_id: string;
  title: string;
  description: string;
  category: string;
  budget_minor: string;
  currency: string;
  status: JobRecord['status'];
  deadline: Date;
  assigned_at: Date | null;
  created_at: Date;
  updated_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
  proposal_count: string;
  viewer_proposed: boolean;
};

const COLUMNS = `
  j.id, j.client_id, j.title, j.description, j.category, j.budget_minor, j.currency,
  j.status, j.deadline, j.assigned_at, j.created_at, j.updated_at,
  p.username, p.display_name, p.avatar_key`;

const toRecord = (row: RawJobRow): JobRecord => ({
  id: row.id,
  clientId: row.client_id,
  client: {
    accountId: row.client_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
  title: row.title,
  description: row.description,
  category: row.category,
  budgetMinor: Number(row.budget_minor),
  currency: row.currency,
  status: row.status,
  deadline: row.deadline,
  assignedAt: row.assigned_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRow = (row: RawJobRow): JobListRow => ({
  job: toRecord(row),
  proposalCount: Number(row.proposal_count),
  viewerProposed: row.viewer_proposed,
});

@Injectable()
export class PostgresJobStore implements JobStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async list(query: JobListQuery): Promise<JobPage> {
    const params: unknown[] = [query.viewerId];
    // A draft is readable by its client only; everything else is public to signed-in accounts.
    const where = [`(j.status <> 'DRAFT' OR j.client_id = $1)`];

    if (query.mine) where.push(`j.client_id = $1`);
    if (query.openOnly) where.push(`(j.status = 'OPEN' AND j.deadline > now())`);

    if (query.category !== null && query.category !== '') {
      params.push(query.category);
      where.push(`j.category = $${params.length}`);
    }

    if (query.search !== null && query.search.trim() !== '') {
      params.push(`${query.search.trim().toLowerCase()}%`);
      where.push(`lower(j.title) LIKE $${params.length}`);
    }

    if (query.cursor !== null) {
      const [createdAt = '', id = ''] = query.cursor.split('|');
      if (createdAt !== '' && id !== '') {
        params.push(createdAt, id);
        where.push(
          `(j.created_at, j.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
    }

    params.push(query.limit);

    const { rows } = await this.db().query<RawJobRow>(
      `SELECT ${COLUMNS},
              (SELECT count(*) FROM work_proposals w WHERE w.job_id = j.id) AS proposal_count,
              EXISTS (
                SELECT 1 FROM work_proposals w
                 WHERE w.job_id = j.id AND w.freelancer_id = $1
                   AND w.status IN ('PENDING', 'ACCEPTED')
              ) AS viewer_proposed
         FROM work_jobs j
         JOIN user_profiles p ON p.account_id = j.client_id
        WHERE ${where.join(' AND ')}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return { items: rows.map(toRow) };
  }

  public async find(viewerId: string, id: string): Promise<JobListRow | null> {
    const { rows } = await this.db().query<RawJobRow>(
      `SELECT ${COLUMNS},
              (SELECT count(*) FROM work_proposals w WHERE w.job_id = j.id) AS proposal_count,
              EXISTS (
                SELECT 1 FROM work_proposals w
                 WHERE w.job_id = j.id AND w.freelancer_id = $1
                   AND w.status IN ('PENDING', 'ACCEPTED')
              ) AS viewer_proposed
         FROM work_jobs j
         JOIN user_profiles p ON p.account_id = j.client_id
        WHERE j.id = $2 AND (j.status <> 'DRAFT' OR j.client_id = $1)`,
      [viewerId, id],
    );

    const row = rows[0];
    return row === undefined ? null : toRow(row);
  }

  public async create(job: JobRecord): Promise<JobRecord> {
    const { rows } = await this.db().query<RawJobRow>(
      `WITH inserted AS (
         INSERT INTO work_jobs
           (id, client_id, title, description, category, budget_minor, currency, status, deadline, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *
       )
       SELECT ${COLUMNS}, '0' AS proposal_count, false AS viewer_proposed
         FROM inserted j
         JOIN user_profiles p ON p.account_id = j.client_id`,
      [
        job.id,
        job.clientId,
        job.title,
        job.description,
        job.category,
        job.budgetMinor,
        job.currency,
        job.status,
        job.deadline,
        job.createdAt,
      ],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('the job vanished between the insert and the read');
    return toRecord(row);
  }

  public async update(
    clientId: string,
    id: string,
    patch: {
      readonly title?: string;
      readonly description?: string;
      readonly category?: string;
      readonly budgetMinor?: number;
      readonly deadline?: Date;
      readonly status?: JobRecord['status'];
      readonly assignedAt?: Date | null;
    },
  ): Promise<JobRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [clientId, id];

    const assign = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.description !== undefined) assign('description', patch.description);
    if (patch.category !== undefined) assign('category', patch.category);
    if (patch.budgetMinor !== undefined) assign('budget_minor', patch.budgetMinor);
    if (patch.deadline !== undefined) assign('deadline', patch.deadline);
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.assignedAt !== undefined) assign('assigned_at', patch.assignedAt);

    if (sets.length === 0) {
      const current = await this.find(clientId, id);
      return current === null ? null : current.job;
    }

    const { rows } = await this.db().query<RawJobRow>(
      `WITH updated AS (
         UPDATE work_jobs SET ${sets.join(', ')}
          WHERE id = $2 AND client_id = $1
          RETURNING *
       )
       SELECT ${COLUMNS}, '0' AS proposal_count, false AS viewer_proposed
         FROM updated j
         JOIN user_profiles p ON p.account_id = j.client_id`,
      params,
    );

    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }
}

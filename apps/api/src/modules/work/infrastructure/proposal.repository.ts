/**
 * Proposal persistence.
 *
 * `award()` is the one method here that must be atomic, and it does three things in a single
 * transaction:
 *
 *   1. accept the chosen proposal,
 *   2. reject every other pending one on the job,
 *   3. move the job to `ASSIGNED`.
 *
 * Any two of those without the third is a lie the UI will show: an award with open proposals
 * still collecting bids, or a job marked filled with nobody accepted. The database also has a
 * partial unique index on `(job_id) WHERE status = 'ACCEPTED'`, so a second acceptance is a
 * constraint violation even if two requests arrive at once.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type { AwardOutcome, ProposalRecord, ProposalStore } from '../application/ports.js';

type RawProposalRow = {
  id: string;
  job_id: string;
  freelancer_id: string;
  bid_minor: string;
  currency: string;
  cover_letter: string;
  delivery_days: number;
  status: ProposalRecord['status'];
  created_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
};

const COLUMNS = `
  pr.id, pr.job_id, pr.freelancer_id, pr.bid_minor, pr.currency, pr.cover_letter,
  pr.delivery_days, pr.status, pr.created_at,
  p.username, p.display_name, p.avatar_key`;

const toRecord = (row: RawProposalRow): ProposalRecord => ({
  id: row.id,
  jobId: row.job_id,
  freelancerId: row.freelancer_id,
  freelancer: {
    accountId: row.freelancer_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
  bidMinor: Number(row.bid_minor),
  currency: row.currency,
  coverLetter: row.cover_letter,
  deliveryDays: row.delivery_days,
  status: row.status,
  createdAt: row.created_at,
});

/** Postgres' unique violation. */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class PostgresProposalStore implements ProposalStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async listForJob(jobId: string): Promise<readonly ProposalRecord[]> {
    const { rows } = await this.db().query<RawProposalRow>(
      `SELECT ${COLUMNS}
         FROM work_proposals pr
         JOIN user_profiles p ON p.account_id = pr.freelancer_id
        WHERE pr.job_id = $1
        ORDER BY pr.created_at DESC`,
      [jobId],
    );
    return rows.map(toRecord);
  }

  public async find(id: string): Promise<ProposalRecord | null> {
    const { rows } = await this.db().query<RawProposalRow>(
      `SELECT ${COLUMNS}
         FROM work_proposals pr
         JOIN user_profiles p ON p.account_id = pr.freelancer_id
        WHERE pr.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Inserts a proposal, answering `null` when one is already live.
   *
   * The partial unique index closes the race between the service's check and this insert, so a
   * double-submitted form cannot produce two live proposals from the same person.
   */
  public async create(proposal: ProposalRecord): Promise<ProposalRecord | null> {
    try {
      const { rows } = await this.db().query<RawProposalRow>(
        `WITH inserted AS (
           INSERT INTO work_proposals
             (id, job_id, freelancer_id, bid_minor, currency, cover_letter, delivery_days, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           RETURNING *
         )
         SELECT ${COLUMNS}
           FROM inserted pr
           JOIN user_profiles p ON p.account_id = pr.freelancer_id`,
        [
          proposal.id,
          proposal.jobId,
          proposal.freelancerId,
          proposal.bidMinor,
          proposal.currency,
          proposal.coverLetter,
          proposal.deliveryDays,
          proposal.status,
          proposal.createdAt,
        ],
      );

      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return null;
      throw error;
    }
  }

  public async award(input: {
    readonly jobId: string;
    readonly proposalId: string;
    readonly at: Date;
  }): Promise<AwardOutcome | null> {
    const client = await this.pools.pool().connect();

    try {
      await client.query('BEGIN');

      // Lock the job first: two clients' tabs accepting simultaneously would otherwise both
      // read it as OPEN and both attempt the update.
      const job = await client.query<{ status: string; deadline: Date }>(
        'SELECT status, deadline FROM work_jobs WHERE id = $1 FOR UPDATE',
        [input.jobId],
      );

      const jobRow = job.rows[0];
      if (jobRow === undefined) {
        await client.query('ROLLBACK');
        return null;
      }

      if (jobRow.status !== 'OPEN' || jobRow.deadline.getTime() <= input.at.getTime()) {
        await client.query('ROLLBACK');
        return { kind: 'JOB_NOT_OPEN' };
      }

      const accepted = await client.query<RawProposalRow>(
        `WITH accepted AS (
           UPDATE work_proposals SET status = 'ACCEPTED', updated_at = $2
            WHERE id = $1 AND job_id = $3 AND status = 'PENDING'
            RETURNING *
         )
         SELECT ${COLUMNS}
           FROM accepted pr
           JOIN user_profiles p ON p.account_id = pr.freelancer_id`,
        [input.proposalId, input.at, input.jobId],
      );

      if (accepted.rows[0] === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'NOT_PENDING' };
      }

      // Everyone else hears "no" in the same transaction the winner hears "yes".
      const rejected = await client.query(
        `UPDATE work_proposals SET status = 'REJECTED', updated_at = $2
          WHERE job_id = $1 AND status = 'PENDING'`,
        [input.jobId, input.at],
      );

      await client.query(
        `UPDATE work_jobs SET status = 'ASSIGNED', assigned_at = $2 WHERE id = $1`,
        [input.jobId, input.at],
      );

      await client.query('COMMIT');

      return {
        kind: 'AWARDED',
        accepted: toRecord(accepted.rows[0]),
        rejected: rejected.rowCount ?? 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async withdraw(freelancerId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `UPDATE work_proposals SET status = 'WITHDRAWN', updated_at = now()
        WHERE id = $1 AND freelancer_id = $2 AND status = 'PENDING'`,
      [id, freelancerId],
    );
    return rowCount === 1;
  }
}

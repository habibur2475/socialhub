/**
 * Contract persistence.
 *
 * Three operations are transactions rather than statements, and all three for the same reason:
 * the escrow ledger and the milestone it pays for must move together.
 *
 *   * `create` writes the contract, its plan, and the client's funding entries in one
 *     transaction. The `DEFERRABLE INITIALLY DEFERRED` trigger on the plan's total is what lets
 *     the milestones be written one at a time inside it — and what refuses the whole thing at
 *     commit if they do not add up.
 *   * `moveMilestone` with a release writes the `RELEASE` and `FEE` entries in the same
 *     statement that marks the milestone released. A released milestone with no ledger entry is
 *     a payment nobody can trace.
 *   * `resolveDispute` places the whole held balance and then closes the dispute, so the two
 *     cannot disagree about where the money went.
 *
 * The balance is always `sum(work_escrow_entries.amount_minor)`. There is no balance column to
 * fall out of step with the ledger.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type {
  ContractListQuery,
  ContractRecord,
  ContractStore,
  MilestoneRecord,
  WorkParty,
} from '../application/ports.js';

type RawContractRow = {
  id: string;
  job_id: string;
  job_title: string;
  client_id: string;
  freelancer_id: string;
  amount_minor: string;
  currency: string;
  status: ContractRecord['status'];
  dispute_open_at: Date | null;
  created_at: Date;
  updated_at: Date;
  client_username: string;
  client_display_name: string;
  client_avatar_key: string | null;
  freelancer_username: string;
  freelancer_display_name: string;
  freelancer_avatar_key: string | null;
  held_minor: string;
  released_minor: string;
};

type RawMilestoneRow = {
  id: string;
  contract_id: string;
  position: number;
  title: string;
  amount_minor: string;
  status: MilestoneRecord['status'];
  submitted_at: Date | null;
  released_at: Date | null;
};

/**
 * The shared column list.
 *
 * `released_minor` is gross, summed from the milestones rather than from the ledger: the
 * `RELEASE` entries are net of the platform fee, and a page reporting 28,500 released against a
 * 30,000 milestone would read as a mistake. Gross keeps `held + released = amount` true at every
 * point, which is the number both parties signed up to.
 */
const COLUMNS = `
  c.id, c.job_id, j.title AS job_title, c.client_id, c.freelancer_id,
  c.amount_minor, c.currency, c.status, c.dispute_open_at, c.created_at, c.updated_at,
  client.username AS client_username, client.display_name AS client_display_name,
  client.avatar_key AS client_avatar_key,
  freelancer.username AS freelancer_username, freelancer.display_name AS freelancer_display_name,
  freelancer.avatar_key AS freelancer_avatar_key,
  work_contract_balance(c.id) AS held_minor,
  COALESCE((SELECT sum(m.amount_minor) FROM work_milestones m
             WHERE m.contract_id = c.id AND m.status = 'RELEASED'), 0) AS released_minor`;

const JOINS = `
  JOIN work_jobs j ON j.id = c.job_id
  JOIN user_profiles client ON client.account_id = c.client_id
  JOIN user_profiles freelancer ON freelancer.account_id = c.freelancer_id`;

const party = (
  id: string,
  username: string,
  displayName: string,
  avatarKey: string | null,
): WorkParty => ({ accountId: id, username, displayName, avatarKey });

const toMilestone = (row: RawMilestoneRow): MilestoneRecord => ({
  id: row.id,
  contractId: row.contract_id,
  position: row.position,
  title: row.title,
  amountMinor: Number(row.amount_minor),
  status: row.status,
  submittedAt: row.submitted_at,
  releasedAt: row.released_at,
});

@Injectable()
export class PostgresContractStore implements ContractStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  /** Milestones for a set of contracts in one query rather than N. */
  private async hydrate(
    rows: readonly RawContractRow[],
    db: Queryable = this.db(),
  ): Promise<ContractRecord[]> {
    if (rows.length === 0) return [];

    const { rows: milestones } = await db.query<RawMilestoneRow>(
      `SELECT id, contract_id, position, title, amount_minor, status, submitted_at, released_at
         FROM work_milestones WHERE contract_id = ANY($1::uuid[])
        ORDER BY contract_id, position`,
      [rows.map((row) => row.id)],
    );

    const byContract = new Map<string, MilestoneRecord[]>();
    for (const milestone of milestones) {
      const list = byContract.get(milestone.contract_id) ?? [];
      list.push(toMilestone(milestone));
      byContract.set(milestone.contract_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      jobTitle: row.job_title,
      clientId: row.client_id,
      freelancerId: row.freelancer_id,
      client: party(
        row.client_id,
        row.client_username,
        row.client_display_name,
        row.client_avatar_key,
      ),
      freelancer: party(
        row.freelancer_id,
        row.freelancer_username,
        row.freelancer_display_name,
        row.freelancer_avatar_key,
      ),
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      status: row.status,
      disputeOpen: row.dispute_open_at !== null,
      milestones: byContract.get(row.id) ?? [],
      heldMinor: Number(row.held_minor),
      releasedMinor: Number(row.released_minor),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public async list(
    query: ContractListQuery,
  ): Promise<{ readonly items: readonly ContractRecord[] }> {
    const params: unknown[] = [query.viewerId];
    if (query.cursor !== null) {
      const [createdAt = '', id = ''] = query.cursor.split('|');
      if (createdAt !== '' && id !== '') {
        params.push(createdAt, id);
        params.push(query.limit);
        const { rows } = await this.db().query<RawContractRow>(
          `SELECT ${COLUMNS} FROM work_contracts c ${JOINS}
            WHERE (c.client_id = $1 OR c.freelancer_id = $1)
              AND (c.created_at, c.id) < ($2::timestamptz, $3::uuid)
            ORDER BY c.created_at DESC, c.id DESC LIMIT $4`,
          params,
        );
        return { items: await this.hydrate(rows) };
      }
    }

    params.push(query.limit);
    const { rows } = await this.db().query<RawContractRow>(
      `SELECT ${COLUMNS} FROM work_contracts c ${JOINS}
        WHERE (c.client_id = $1 OR c.freelancer_id = $1)
        ORDER BY c.created_at DESC, c.id DESC LIMIT $2`,
      params,
    );

    return { items: await this.hydrate(rows) };
  }

  public async find(viewerId: string, id: string): Promise<ContractRecord | null> {
    const { rows } = await this.db().query<RawContractRow>(
      `SELECT ${COLUMNS} FROM work_contracts c ${JOINS}
        WHERE c.id = $2 AND (c.client_id = $1 OR c.freelancer_id = $1)`,
      [viewerId, id],
    );

    const hydrated = await this.hydrate(rows);
    return hydrated[0] ?? null;
  }

  public async findForOperator(id: string): Promise<ContractRecord | null> {
    const { rows } = await this.db().query<RawContractRow>(
      `SELECT ${COLUMNS} FROM work_contracts c ${JOINS} WHERE c.id = $1`,
      [id],
    );
    const hydrated = await this.hydrate(rows);
    return hydrated[0] ?? null;
  }

  /**
   * Creates the contract and its plan, and funds it, in one transaction.
   *
   * The milestone amounts are written before the `FUND` entries so the deferred plan check runs
   * against a complete plan. Each milestone is `FUNDED` at this point: the client agreed to the
   * plan and paid for it when they awarded the job, so a "planned but unfunded" milestone would
   * be an intermediate state the UI has to explain and nobody asked for.
   */
  public async create(input: {
    readonly id: string;
    readonly jobId: string;
    readonly clientId: string;
    readonly freelancerId: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly milestones: readonly {
      readonly id: string;
      readonly title: string;
      readonly amountMinor: number;
    }[];
    readonly at: Date;
  }): Promise<ContractRecord> {
    const client = await this.pools.pool().connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO work_contracts
           (id, job_id, client_id, freelancer_id, amount_minor, currency, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)`,
        [
          input.id,
          input.jobId,
          input.clientId,
          input.freelancerId,
          input.amountMinor,
          input.currency,
          input.at,
        ],
      );

      for (const [index, milestone] of input.milestones.entries()) {
        await client.query(
          `INSERT INTO work_milestones
             (id, contract_id, position, title, amount_minor, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'FUNDED', $6, $6)`,
          [milestone.id, input.id, index + 1, milestone.title, milestone.amountMinor, input.at],
        );

        await client.query(
          `INSERT INTO work_escrow_entries (id, contract_id, milestone_id, kind, amount_minor, currency, actor, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'FUND', $3, $4, 'CLIENT', $5)`,
          [input.id, milestone.id, milestone.amountMinor, input.currency, input.at],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const created = await this.findById(input.id);
    if (created === null) throw new Error('the contract vanished between the insert and the read');
    return created;
  }

  /** An id-only read, for the caller that just created it and has already proved ownership. */
  private async findById(id: string): Promise<ContractRecord | null> {
    const { rows } = await this.db().query<RawContractRow>(
      `SELECT ${COLUMNS} FROM work_contracts c ${JOINS} WHERE c.id = $1`,
      [id],
    );
    const hydrated = await this.hydrate(rows);
    return hydrated[0] ?? null;
  }

  public async setStatus(id: string, status: ContractRecord['status'], at: Date): Promise<void> {
    await this.db().query('UPDATE work_contracts SET status = $2, updated_at = $3 WHERE id = $1', [
      id,
      status,
      at,
    ]);
  }

  /**
   * Moves one milestone, and — when it is being released — writes the money out with it.
   *
   * The conditional `WHERE status = $from` is the concurrency guard: two clicks on "approve"
   * would otherwise both pass the service's check and both write a release, paying the
   * freelancer twice. Zero rows updated means somebody else got there first.
   */
  public async moveMilestone(input: {
    readonly contractId: string;
    readonly milestoneId: string;
    readonly from: MilestoneRecord['status'];
    readonly to: MilestoneRecord['status'];
    readonly at: Date;
    readonly escrow?: { readonly feeMinor: number; readonly netMinor: number };
  }): Promise<boolean> {
    const client = await this.pools.pool().connect();

    try {
      await client.query('BEGIN');

      const updates: string[] = ['status = $4', 'updated_at = $5'];
      const params: unknown[] = [
        input.milestoneId,
        input.contractId,
        input.from,
        input.to,
        input.at,
      ];

      if (input.to === 'SUBMITTED') updates.push('submitted_at = $5');
      if (input.to === 'RELEASED') {
        updates.push('submitted_at = COALESCE(submitted_at, $5)', 'released_at = $5');
      }

      const { rowCount } = await client.query(
        `UPDATE work_milestones SET ${updates.join(', ')}
          WHERE id = $1 AND contract_id = $2 AND status = $3`,
        params,
      );

      if (rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }

      const currency = (
        await client.query<{ currency: string }>(
          'SELECT currency FROM work_contracts WHERE id = $1',
          [input.contractId],
        )
      ).rows[0]?.currency;

      if (currency === undefined) {
        await client.query('ROLLBACK');
        return false;
      }

      if (input.to === 'FUNDED') {
        // Funding a milestone is the client putting the money in. The amount comes from the
        // milestone row itself rather than from the caller, so the entry and the thing it pays
        // for cannot be given different numbers.
        const amount = (
          await client.query<{ amount_minor: string }>(
            'SELECT amount_minor FROM work_milestones WHERE id = $1',
            [input.milestoneId],
          )
        ).rows[0]?.amount_minor;

        if (amount === undefined) {
          await client.query('ROLLBACK');
          return false;
        }

        await client.query(
          `INSERT INTO work_escrow_entries (id, contract_id, milestone_id, kind, amount_minor, currency, actor, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'FUND', $3, $4, 'CLIENT', $5)`,
          [input.contractId, input.milestoneId, amount, currency, input.at],
        );
      }

      if (input.escrow !== undefined) {
        // Two entries for one release: the fee the platform keeps and the net the freelancer
        // receives. Writing them separately is what makes the balance reconcile without a
        // "how much did we earn this month" report re-deriving it from rates.
        await client.query(
          `INSERT INTO work_escrow_entries (id, contract_id, milestone_id, kind, amount_minor, currency, actor, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'RELEASE', $3, $4, 'CLIENT', $5),
                  (gen_random_uuid(), $1, $2, 'FEE', $6, $4, 'PLATFORM', $5)`,
          [
            input.contractId,
            input.milestoneId,
            -input.escrow.netMinor,
            currency,
            input.at,
            -input.escrow.feeMinor,
          ],
        );
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async openDispute(contractId: string, reason: string, at: Date): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `UPDATE work_contracts
          SET status = 'DISPUTED', dispute_open_at = $2, dispute_reason = $3, updated_at = $2
        WHERE id = $1 AND dispute_open_at IS NULL`,
      [contractId, at, reason],
    );
    return rowCount === 1;
  }

  public async resolveDispute(input: {
    readonly contractId: string;
    readonly outcome: 'RELEASED_TO_FREELANCER' | 'REFUNDED_TO_CLIENT';
    readonly toFreelancerMinor: number;
    readonly currency: string;
    readonly at: Date;
  }): Promise<void> {
    const client = await this.pools.pool().connect();

    try {
      await client.query('BEGIN');

      const held = await client.query<{ held: string; freelancer_id: string }>(
        `SELECT work_contract_balance($1) AS held, freelancer_id FROM work_contracts WHERE id = $1`,
        [input.contractId],
      );

      const row = held.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        return;
      }

      const heldMinor = Number(row.held);
      const toClient = heldMinor - input.toFreelancerMinor;

      // Place the whole balance. A resolution that left a remainder would strand money in an
      // escrow nobody is looking at.
      if (input.toFreelancerMinor > 0) {
        await client.query(
          `INSERT INTO work_escrow_entries (id, contract_id, kind, amount_minor, currency, actor, created_at)
           VALUES (gen_random_uuid(), $1, 'RELEASE', $2, $3, 'PLATFORM', $4)`,
          [input.contractId, -input.toFreelancerMinor, input.currency, input.at],
        );
      }

      if (toClient > 0) {
        await client.query(
          `INSERT INTO work_escrow_entries (id, contract_id, kind, amount_minor, currency, actor, created_at)
           VALUES (gen_random_uuid(), $1, 'REFUND', $2, $3, 'PLATFORM', $4)`,
          [input.contractId, -toClient, input.currency, input.at],
        );
      }

      await client.query(
        `UPDATE work_contracts
            SET status = 'CANCELLED',
                dispute_resolved_at = $2,
                dispute_outcome = $3,
                dispute_to_freelancer_minor = $4,
                updated_at = $2
          WHERE id = $1`,
        [input.contractId, input.at, input.outcome, input.toFreelancerMinor],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

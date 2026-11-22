/**
 * Work end-to-end tests.
 *
 * The properties that need a database and a real HTTP stack:
 *
 *   * the award is **one transaction** — accepting a proposal, closing the others and moving
 *     the job cannot happen apart, so two clients' tabs cannot produce a job that reads as
 *     filled while a dozen people still expect an answer;
 *   * the escrow is an append-only signed ledger and the balance is its `sum()`, so a release
 *     that writes no entry does not happen at all;
 *   * the plan is checked by a deferred constraint trigger, which means a plan that does not
 *     add up cannot be committed even by something that bypasses the service;
 *   * a dispute freezes the money — the same approval that worked a second earlier is refused.
 */

import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { RequestMethod, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter.js';
import { MemoryCache } from '../../common/cache/memory-cache.js';
import { CACHE } from '../../database/cache.provider.js';
import { JsonLogger } from '../../common/logging/logger.js';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

const PASSWORD = 'correct-horse-battery';

type Actor = { accountId: string; username: string; accessToken: string };

type Job = {
  id: string;
  title: string;
  status: string;
  budgetMinor: number;
  proposalCount: number;
  isClient: boolean;
  hasProposed: boolean;
  isAcceptingProposals: boolean;
  myProposal: { id: string; bidMinor: number; status: string } | null;
};

type Contract = {
  id: string;
  status: string;
  amountMinor: number;
  heldMinor: number;
  releasedMinor: number;
  disputeOpen: boolean;
  isClient: boolean;
  isFreelancer: boolean;
  availableActions: string[];
  milestones: { id: string; title: string; amountMinor: number; status: string }[];
};

const deadlineIn = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

describeWithDb('work (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = CONNECTION;
    process.env['NODE_ENV'] = 'test';
    process.env['CACHE_DRIVER'] = 'memory';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-with-at-least-32-characters';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-with-at-least-32-chars-x';
    process.env['LOG_LEVEL'] = 'fatal';
    process.env['OTP_TTL_SECONDS'] = '600';

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CACHE)
      .useFactory({ factory: () => new MemoryCache(), inject: [] })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: new JsonLogger('fatal'),
    });
    app.useGlobalFilters(new AllExceptionsFilter(new JsonLogger('fatal')));
    app.use(cookieParser());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    pool = new Pool({ connectionString: CONNECTION, max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    // The escrow is append-only for every writer, including this one: a test that could
    // `DELETE` its ledger could also leave a contract whose balance is a lie. The truncate is
    // the one reset the trigger permits, because it does not go through the row-level path.
    await pool.query('TRUNCATE work_escrow_entries, work_milestones, work_contracts CASCADE');
    await pool.query('DELETE FROM work_proposals');
    await pool.query('DELETE FROM work_jobs');
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM message_participants');
    await pool.query('DELETE FROM message_threads');
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM notes');
    await pool.query('DELETE FROM blocks');
    await pool.query('DELETE FROM follows');
    await pool.query('DELETE FROM verification_codes');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM user_roles');
    await pool.query('DELETE FROM user_profiles');
    await pool.query(`DELETE FROM accounts WHERE account_type = 'USER'`);
  });

  const createActor = async (): Promise<Actor> => {
    const email = `w-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Work Tester' })
      .expect(202);

    const { rows } = await pool.query<{ code_digest: Buffer; id: string }>(
      `SELECT vc.code_digest, a.id FROM verification_codes vc
         JOIN accounts a ON a.id = vc.account_id
        WHERE a.email = $1 AND vc.purpose = 'EMAIL_VERIFY'`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('verification code missing');

    const { digestOtp } = await import('../auth/domain/one-time-code.js');
    let code = '';
    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const attempt = candidate.toString().padStart(6, '0');
      if (
        digestOtp({ accountId: row.id, purpose: 'EMAIL_VERIFY', code: attempt }).equals(
          row.code_digest,
        )
      ) {
        code = attempt;
        break;
      }
    }
    if (code === '') throw new Error('could not recover OTP');

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ email, code })
      .expect(200);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return { accountId: row.id, username, accessToken: login.body.accessToken as string };
  };

  const auth = (actor: Actor) => ({ authorization: `Bearer ${actor.accessToken}` });

  const createJob = async (
    actor: Actor,
    input: Partial<{ title: string; budget: string; deadline: string; status: string }> = {},
  ): Promise<Job> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/work/jobs')
      .set(auth(actor))
      .send({
        title: input.title ?? `Write copy ${randomUUID().slice(0, 8)}`,
        description: 'Two paragraphs, plain English, no jargon.',
        category: 'writing',
        budget: input.budget ?? '600',
        currency: 'BDT',
        deadline: input.deadline ?? deadlineIn(14),
        status: input.status ?? 'OPEN',
      })
      .expect(201);

    return response.body as Job;
  };

  const propose = (actor: Actor, jobId: string, bid = '600') =>
    request(app.getHttpServer())
      .post(`/api/v1/work/jobs/${jobId}/proposals`)
      .set(auth(actor))
      .send({
        bid,
        coverLetter: 'I have written four launch posts this year and can send samples today.',
        deliveryDays: 5,
      });

  const award = (
    actor: Actor,
    jobId: string,
    proposalId: string,
    milestones: { title: string; amount: string }[],
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/work/jobs/${jobId}/actions`)
      .set(auth(actor))
      .send({ action: 'AWARD', proposalId, milestones });

  const milestoneAction = (actor: Actor, contractId: string, milestoneId: string, action: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/work/contracts/${contractId}/milestones/${milestoneId}/actions`)
      .set(auth(actor))
      .send({ action });

  const balance = async (contractId: string): Promise<number> => {
    const { rows } = await pool.query<{ held: string }>(
      'SELECT work_contract_balance($1) AS held',
      [contractId],
    );
    return Number(rows[0]?.held ?? '0');
  };

  /** A job, a freelancer on it, and the award — the setup most of these tests start from. */
  const hired = async () => {
    const client = await createActor();
    const freelancer = await createActor();
    const job = await createJob(client);
    const proposal = await propose(freelancer, job.id, '600');

    const awarded = await award(client, job.id, proposal.body.id as string, [
      { title: 'First draft', amount: '300' },
      { title: 'Final copy', amount: '300' },
    ]);
    expect(awarded.status).toBe(200);

    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM work_contracts WHERE job_id = $1',
      [job.id],
    );
    const contractId = rows[0]?.id;
    if (contractId === undefined) throw new Error('the award created no contract');

    const contract = await request(app.getHttpServer())
      .get(`/api/v1/work/contracts/${contractId}`)
      .set(auth(client))
      .expect(200);

    return {
      client,
      freelancer,
      job,
      contractId,
      contract: contract.body as Contract,
      milestones: (contract.body as Contract).milestones,
    };
  };

  describe('the board', () => {
    it('lists a published job for anyone signed in, and says who may bid', async () => {
      const client = await createActor();
      const viewer = await createActor();
      const job = await createJob(client);

      const response = await request(app.getHttpServer())
        .get('/api/v1/work/jobs')
        .set(auth(viewer))
        .expect(200);

      const listed = (response.body.items as Job[]).find((entry) => entry.id === job.id);
      expect(listed).toMatchObject({
        budgetMinor: 60_000,
        isClient: false,
        hasProposed: false,
        isAcceptingProposals: true,
      });
    });

    it('keeps a draft to its client', async () => {
      const client = await createActor();
      const stranger = await createActor();
      const job = await createJob(client, { status: 'DRAFT' });

      await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(stranger))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(client))
        .expect(200);
    });

    it('never advertises a job whose deadline has passed, even if its status says OPEN', async () => {
      const client = await createActor();
      const viewer = await createActor();

      // Written straight to the table: the API refuses to create this, which is the point —
      // the column can still be stale, and the board must not believe it.
      const stale = randomUUID();
      await pool.query(
        `INSERT INTO work_jobs (id, client_id, title, category, budget_minor, currency, status, deadline)
         VALUES ($1, $2, 'A job that expired yesterday', 'writing', 60000, 'BDT', 'OPEN', now() - interval '1 day')`,
        [stale, client.accountId],
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/work/jobs')
        .set(auth(viewer))
        .expect(200);
      expect((response.body.items as Job[]).some((entry) => entry.id === stale)).toBe(false);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${stale}`)
        .set(auth(viewer))
        .expect(200);
      expect(detail.body).toMatchObject({ isAcceptingProposals: false });
    });

    it('rejects a non-uuid id before it reaches the database', async () => {
      const viewer = await createActor();
      await request(app.getHttpServer())
        .get('/api/v1/work/jobs/not-a-uuid')
        .set(auth(viewer))
        .expect(400);
    });
  });

  describe('proposals', () => {
    it('records a bid below the budget and hides it from the other freelancers', async () => {
      const client = await createActor();
      const freelancer = await createActor();
      const other = await createActor();
      const job = await createJob(client);

      const created = await propose(freelancer, job.id, '450').expect(201);
      expect(created.body).toMatchObject({ bidMinor: 45_000, status: 'PENDING' });

      const mine = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(freelancer))
        .expect(200);
      expect(mine.body.myProposal).toMatchObject({ bidMinor: 45_000 });

      const theirs = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(other))
        .expect(200);
      expect(theirs.body.myProposal).toBeNull();
    });

    it('refuses a bid above the budget and a second live proposal', async () => {
      const client = await createActor();
      const freelancer = await createActor();
      const job = await createJob(client);

      const tooHigh = await propose(freelancer, job.id, '900').expect(422);
      expect(tooHigh.body.error.message).toBe('Your bid is above the budget the client posted');

      await propose(freelancer, job.id).expect(201);
      const again = await propose(freelancer, job.id, '500').expect(422);
      expect(again.body.error.message).toBe('You already have a proposal on this job');
    });

    it('frees the slot when a proposal is withdrawn', async () => {
      const client = await createActor();
      const freelancer = await createActor();
      const job = await createJob(client);

      const first = await propose(freelancer, job.id).expect(201);
      await request(app.getHttpServer())
        .delete(`/api/v1/work/proposals/${first.body.id}`)
        .set(auth(freelancer))
        .expect(204);

      await propose(freelancer, job.id, '550').expect(201);
    });

    it('keeps the proposal inbox to the client', async () => {
      const client = await createActor();
      const freelancer = await createActor();
      const job = await createJob(client);
      await propose(freelancer, job.id).expect(201);

      const inbox = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}/proposals`)
        .set(auth(client))
        .expect(200);
      expect(inbox.body).toHaveLength(1);

      await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}/proposals`)
        .set(auth(freelancer))
        .expect(403);
    });
  });

  describe('awarding', () => {
    it('accepts one, closes the rest, and creates a funded contract for the bid', async () => {
      const client = await createActor();
      const first = await createActor();
      const second = await createActor();
      const job = await createJob(client);

      const winner = await propose(first, job.id, '600').expect(201);
      const loser = await propose(second, job.id, '580').expect(201);

      await award(client, job.id, winner.body.id, [
        { title: 'First draft', amount: '300' },
        { title: 'Final copy', amount: '300' },
      ]).expect(200);

      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM work_proposals WHERE job_id = $1 ORDER BY bid_minor ASC',
        [job.id],
      );
      expect(rows.map((row) => row.status)).toEqual(['REJECTED', 'ACCEPTED']);
      expect(loser.body.id).not.toBe(winner.body.id);

      const shown = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(client))
        .expect(200);
      expect(shown.body).toMatchObject({ status: 'ASSIGNED', isAcceptingProposals: false });

      const contracts = await request(app.getHttpServer())
        .get('/api/v1/work/contracts')
        .set(auth(first))
        .expect(200);

      const contract = (contracts.body.items as Contract[])[0];
      expect(contract).toMatchObject({
        amountMinor: 60_000,
        heldMinor: 60_000,
        releasedMinor: 0,
        isFreelancer: true,
        status: 'ACTIVE',
      });

      // The client paid at award time, so the escrow already holds the whole plan.
      expect(await balance(contract.id)).toBe(60_000);
      expect(contract.milestones.map((entry) => entry.status)).toEqual(['FUNDED', 'FUNDED']);
    });

    it('refuses a plan that does not add up, and leaves the job open', async () => {
      const client = await createActor();
      const freelancer = await createActor();
      const job = await createJob(client);
      const proposal = await propose(freelancer, job.id).expect(201);

      const refused = await award(client, job.id, proposal.body.id, [
        { title: 'First draft', amount: '300' },
        { title: 'Final copy', amount: '200' },
      ]).expect(422);
      expect(refused.body.error.message).toBe('The milestones must add up to the agreed amount');

      const shown = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(client))
        .expect(200);
      expect(shown.body).toMatchObject({ status: 'OPEN', isAcceptingProposals: true });

      const { rows } = await pool.query('SELECT 1 FROM work_contracts WHERE job_id = $1', [job.id]);
      expect(rows).toHaveLength(0);
    });

    it('cannot be awarded twice, and the database holds that too', async () => {
      const { client, job, freelancer, contractId } = await hired();
      void freelancer;

      const second = await award(client, job.id, randomUUID(), [
        { title: 'Everything', amount: '600' },
      ]).expect(422);
      expect(second.body.error.message).toBe('That is not something you can do to this job yet');

      // And the same rule where it cannot be forgotten: a second acceptance is a unique
      // violation, whoever writes it.
      const { rows } = await pool.query<{ freelancer_id: string }>(
        'SELECT freelancer_id FROM work_contracts WHERE id = $1',
        [contractId],
      );
      await expect(
        pool.query(
          `INSERT INTO work_proposals (id, job_id, freelancer_id, bid_minor, cover_letter, delivery_days, status)
           VALUES (gen_random_uuid(), $1, $2, 60000, 'A second acceptance that must never land.', 5, 'ACCEPTED')`,
          [job.id, rows[0]?.freelancer_id],
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint/u);
    });

    it('refuses a stranger the award', async () => {
      const client = await createActor();
      const stranger = await createActor();
      const freelancer = await createActor();
      const job = await createJob(client);
      const proposal = await propose(freelancer, job.id).expect(201);

      await award(stranger, job.id, proposal.body.id, [
        { title: 'All of it', amount: '600' },
      ]).expect(404);
    });
  });

  describe('milestones and the escrow', () => {
    it('walks a milestone from funded to released, paying the net and the fee', async () => {
      const { client, freelancer, contractId, milestones } = await hired();
      const first = milestones[0];

      // The freelancer delivers; the client cannot do this step for them.
      await milestoneAction(client, contractId, first.id, 'SUBMIT').expect(404);

      const submitted = await milestoneAction(freelancer, contractId, first.id, 'SUBMIT').expect(
        200,
      );
      expect((submitted.body as Contract).milestones[0]?.status).toBe('SUBMITTED');

      const approved = await milestoneAction(client, contractId, first.id, 'APPROVE').expect(200);
      expect(approved.body).toMatchObject({ releasedMinor: 30_000, heldMinor: 30_000 });

      const { rows } = await pool.query<{ kind: string; amount_minor: string }>(
        'SELECT kind, amount_minor FROM work_escrow_entries WHERE contract_id = $1 ORDER BY kind',
        [contractId],
      );
      // Three entries: two funds at award, then the release and its fee.
      expect(rows).toHaveLength(4);
      expect(rows.find((row) => row.kind === 'RELEASE')?.amount_minor).toBe('-28500');
      expect(rows.find((row) => row.kind === 'FEE')?.amount_minor).toBe('-1500');
      expect(await balance(contractId)).toBe(30_000);
    });

    it('closes the contract and the job when the last milestone is released', async () => {
      const { client, freelancer, contractId, job, milestones } = await hired();

      for (const milestone of milestones) {
        await milestoneAction(freelancer, contractId, milestone.id, 'SUBMIT').expect(200);
        await milestoneAction(client, contractId, milestone.id, 'APPROVE').expect(200);
      }

      const closed = await request(app.getHttpServer())
        .get(`/api/v1/work/contracts/${contractId}`)
        .set(auth(client))
        .expect(200);
      expect(closed.body).toMatchObject({
        status: 'COMPLETED',
        releasedMinor: 60_000,
        heldMinor: 0,
      });

      const board = await request(app.getHttpServer())
        .get(`/api/v1/work/jobs/${job.id}`)
        .set(auth(client))
        .expect(200);
      expect(board.body).toMatchObject({ status: 'COMPLETED' });
      expect(await balance(contractId)).toBe(0);
    });

    it('refuses to release the same milestone twice', async () => {
      const { client, freelancer, contractId, milestones } = await hired();
      const first = milestones[0];

      await milestoneAction(freelancer, contractId, first.id, 'SUBMIT').expect(200);
      await milestoneAction(client, contractId, first.id, 'APPROVE').expect(200);

      // Both "already released" and "nobody else moved it first" come back as a refusal rather
      // than a second payout.
      const again = await milestoneAction(client, contractId, first.id, 'APPROVE').expect(422);
      expect(again.body.error.message).toMatch(/does not apply/u);
      expect(await balance(contractId)).toBe(30_000);
    });

    it('keeps the escrow append-only, and the balance is its sum', async () => {
      const { contractId } = await hired();

      await expect(
        pool.query('UPDATE work_escrow_entries SET amount_minor = 0 WHERE contract_id = $1', [
          contractId,
        ]),
      ).rejects.toThrow(/append-only/u);

      // And a release cannot be written as a positive number: the sign carries the meaning.
      await expect(
        pool.query(
          `INSERT INTO work_escrow_entries (id, contract_id, kind, amount_minor, currency, actor)
           VALUES (gen_random_uuid(), $1, 'RELEASE', 100, 'BDT', 'CLIENT')`,
          [contractId],
        ),
      ).rejects.toThrow(/work_escrow_sign_matches_kind/u);
    });

    it('refuses a plan that does not add up at commit, even when inserted directly', async () => {
      const { contractId } = await hired();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO work_milestones (id, contract_id, position, title, amount_minor, status)
           VALUES (gen_random_uuid(), $1, 3, 'An extra milestone', 100, 'PLANNED')`,
          [contractId],
        );
        await expect(client.query('COMMIT')).rejects.toThrow(/do not add up/u);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('refuses an illegal milestone move in the database, not only in the API', async () => {
      const { contractId, milestones } = await hired();
      await expect(
        pool.query(`UPDATE work_milestones SET status = 'RELEASED' WHERE id = $1`, [
          milestones[0]?.id,
        ]),
      ).rejects.toThrow(/illegal milestone transition/u);
    });
  });

  describe('disputes', () => {
    it('freezes the money: the approval that worked before is refused after', async () => {
      const { client, freelancer, contractId, milestones } = await hired();
      const first = milestones[0];
      await milestoneAction(freelancer, contractId, first.id, 'SUBMIT').expect(200);

      const opened = await request(app.getHttpServer())
        .post(`/api/v1/work/contracts/${contractId}/dispute`)
        .set(auth(freelancer))
        .send({ reason: 'The client has stopped answering my messages' })
        .expect(200);
      expect(opened.body).toMatchObject({ disputeOpen: true, status: 'DISPUTED' });

      const refused = await milestoneAction(client, contractId, first.id, 'APPROVE').expect(412);
      expect(refused.body.error.message).toBe('The money is frozen while the dispute is open');
      expect(await balance(contractId)).toBe(60_000);
    });

    it('refuses a second dispute and keeps resolution to support', async () => {
      const { freelancer, client, contractId } = await hired();

      await request(app.getHttpServer())
        .post(`/api/v1/work/contracts/${contractId}/dispute`)
        .set(auth(freelancer))
        .send({ reason: 'The brief changed twice after I started the work' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/work/contracts/${contractId}/dispute`)
        .set(auth(client))
        .send({ reason: 'The work was never delivered and the deadline is near' })
        .expect(409);

      await request(app.getHttpServer())
        .post(`/api/v1/work/contracts/${contractId}/resolve`)
        .set(auth(freelancer))
        .send({ outcome: 'RELEASED_TO_FREELANCER' })
        .expect(403);
    });
  });

  describe('visibility', () => {
    it('shows a contract to its two parties and nobody else', async () => {
      const { contractId, client } = await hired();
      const stranger = await createActor();

      await request(app.getHttpServer())
        .get(`/api/v1/work/contracts/${contractId}`)
        .set(auth(stranger))
        .expect(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/work/contracts')
        .set(auth(stranger))
        .expect(200);
      expect(list.body.items).toHaveLength(0);

      await request(app.getHttpServer())
        .get(`/api/v1/work/contracts/${contractId}`)
        .set(auth(client))
        .expect(200);
    });

    it('requires a session for every route', async () => {
      await request(app.getHttpServer()).get('/api/v1/work/jobs').expect(401);
      await request(app.getHttpServer()).get('/api/v1/work/contracts').expect(401);
    });
  });
});

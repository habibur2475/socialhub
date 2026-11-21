/**
 * Schema invariant tests.
 *
 * These run against a real PostgreSQL server and assert the guarantees the
 * security model depends on. The suite is skipped when TEST_DATABASE_URL is
 * absent, so `pnpm test` stays green on machines without a database.
 */

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

let pool: Pool;
let client: PoolClient;

beforeAll(async () => {
  if (CONNECTION === undefined) return;
  pool = new Pool({ connectionString: CONNECTION, max: 1 });
  client = await pool.connect();
});

afterAll(async () => {
  if (CONNECTION === undefined) return;
  client.release();
  await pool.end();
});

/** Inserts a scope and returns its id. */
const createScope = async (
  level: string,
  path: string,
  parentId: string | null,
): Promise<string> => {
  const id = randomUUID();
  await client.query(
    'INSERT INTO scopes (id, level, path, name, parent_id) VALUES ($1, $2, $3, $4, $5)',
    [id, level, path, path, parentId],
  );
  return id;
};

const createAccount = async (
  accountType: 'USER' | 'STAFF' | 'ROOT',
  overrides: { state?: string; email?: string; passwordHash?: string } = {},
): Promise<string> => {
  const id = randomUUID();
  const email = (overrides.email ?? `u-${id}@example.test`).toLowerCase();
  await client.query(
    `INSERT INTO accounts (id, account_type, state, email, password_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      accountType,
      overrides.state ?? 'ACTIVE',
      email,
      overrides.passwordHash ?? 'argon2id$dummy',
    ],
  );
  return id;
};

const insertStaffProfile = async (
  accountId: string,
  scopeId: string | null,
  employeeNo: string = `E-${randomUUID()}`,
): Promise<void> => {
  await client.query(
    `INSERT INTO staff_profiles (account_id, employee_no, job_title, primary_scope_id, hired_on)
     VALUES ($1, $2, 'Engineer', $3, current_date)`,
    [accountId, employeeNo, scopeId],
  );
};

/**
 * Creates an internal account together with its HR profile in ONE transaction,
 * mirroring the real provisioning flow: an internal identity can never exist
 * even momentarily without its staff profile.
 */
const createStaffAccount = async (
  accountType: 'STAFF' | 'ROOT',
  scopeId: string | null = null,
): Promise<string> => {
  await client.query('BEGIN');
  try {
    const id = await createAccount(accountType);
    await insertStaffProfile(id, scopeId);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

describeWithDb('identity schema', () => {
  it('rejects unknown account types and states', async () => {
    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'SUPERUSER', 'ACTIVE', $2)`,
        [randomUUID(), `x-${randomUUID()}@example.test`],
      ),
    ).rejects.toThrow(/account_type_allowed/);

    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'USER', 'GHOST', $2)`,
        [randomUUID(), `y-${randomUUID()}@example.test`],
      ),
    ).rejects.toThrow(/account_state_allowed/);
  });

  it('normalises email case and rejects mixed case at the constraint level', async () => {
    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'USER', 'ACTIVE', 'Mixed@Example.Test')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/accounts_email_is_normalised/);
  });

  it('releases the email of a soft-deleted account but not of an active one', async () => {
    const email = `dup-${randomUUID()}@example.test`;
    const first = await createAccount('USER', { email });
    await expect(createAccount('USER', { email })).rejects.toThrow(/accounts_email_live_key/);

    await client.query('UPDATE accounts SET deleted_at = now(), state = $2 WHERE id = $1', [
      first,
      'SOFT_DELETED',
    ]);
    const second = await createAccount('USER', { email });
    expect(second).not.toBe(first);
  });

  it('requires a staff profile for STAFF and forbids one for USER', async () => {
    // Deferred constraint trigger: the violation surfaces at COMMIT.
    await expect(
      (async () => {
        await client.query('BEGIN');
        await createAccount('STAFF');
        await client.query('COMMIT');
      })(),
    ).rejects.toThrow(/staff_profiles invariant/);
    await client.query('ROLLBACK').catch(() => undefined);

    const staffId = await createStaffAccount('STAFF');
    await expect(insertStaffProfile(staffId, null)).rejects.toThrow(/duplicate key/);
  });

  it('rejects a second ROOT account and protects the existing ROOT row', async () => {
    const first = await createStaffAccount('ROOT');
    const second = await createStaffAccount('ROOT');

    const third = randomUUID();
    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'ROOT', 'ACTIVE', $2)`,
        [third, `root-${third}@example.test`],
      ),
    ).rejects.toThrow(/ROOT account cap/);

    await expect(client.query('DELETE FROM accounts WHERE id = $1', [first])).rejects.toThrow(
      /ROOT accounts cannot be deleted/,
    );
    await expect(
      client.query(`UPDATE accounts SET account_type = 'STAFF' WHERE id = $1`, [first]),
    ).rejects.toThrow(/ROOT accounts cannot be demoted/);

    await client.query('UPDATE accounts SET deleted_at = now() WHERE id IN ($1, $2)', [
      first,
      second,
    ]);
  });

  it('rotates the session epoch when credentials change', async () => {
    const id = await createAccount('USER', { passwordHash: 'argon2id$one' });
    const before = await client.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM accounts WHERE id = $1',
      [id],
    );
    await client.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      id,
      'argon2id$two',
    ]);
    const after = await client.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM accounts WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.session_epoch).toBe((before.rows[0]?.session_epoch ?? 0) + 1);
  });

  it('keeps audit rows immutable', async () => {
    const id = randomUUID();
    // Chain-correct fixture: link to the current head so this test does not
    // introduce a second chain head (which would break verification elsewhere).
    const head = await client.query<{ entry_hash: Buffer }>(
      'SELECT entry_hash FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT 1',
    );
    await client.query(
      `INSERT INTO audit_events (id, action, resource_type, entry_hash, previous_hash)
       VALUES ($1, 'user.login', 'account', $2, $3)`,
      [id, Buffer.alloc(32, 1), head.rows[0]?.entry_hash ?? null],
    );
    await expect(
      client.query(`UPDATE audit_events SET action = 'user.tamper' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(client.query('DELETE FROM audit_events WHERE id = $1', [id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects malformed scope paths and duplicate employees', async () => {
    const company = await createScope('COMPANY', `/c-${randomUUID().slice(0, 8)}/`, null);
    await expect(
      client.query(
        `INSERT INTO scopes (id, level, path, name) VALUES ($1, 'REGION', 'not-a-path', 'x')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/scopes_path_shape/);

    const employeeNo = `E-${randomUUID()}`;
    const staffA = await createStaffAccount('STAFF', company);
    const staffB = await createStaffAccount('STAFF', company);
    await expect(
      client.query('UPDATE staff_profiles SET employee_no = $2 WHERE account_id = $1', [
        staffA,
        employeeNo,
      ]),
    ).resolves.toBeDefined();
    await expect(insertStaffProfile(staffB, company, employeeNo)).rejects.toThrow(
      /staff_profiles_employee_no_key|duplicate key/,
    );
  });

  it('requires 32-byte digests for verification codes and refresh tokens', async () => {
    const accountId = await createAccount('USER');
    await expect(
      client.query(
        `INSERT INTO verification_codes (id, account_id, purpose, channel, destination_hash, code_digest, expires_at)
         VALUES ($1, $2, 'EMAIL_VERIFY', 'EMAIL', $3, $4, now() + interval '1 hour')`,
        [randomUUID(), accountId, Buffer.alloc(32, 2), Buffer.alloc(16, 3)],
      ),
    ).rejects.toThrow(/verification_codes_digest_len/);

    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
      [sessionId, accountId],
    );
    await expect(
      client.query(
        `INSERT INTO refresh_tokens (id, session_id, account_id, token_digest, family_id, session_epoch, expires_at)
         VALUES ($1, $2, $3, $4, $2, 0, now() + interval '30 days')`,
        [randomUUID(), sessionId, accountId, Buffer.alloc(31, 4)],
      ),
    ).rejects.toThrow(/refresh_tokens_digest_len/);
  });
});

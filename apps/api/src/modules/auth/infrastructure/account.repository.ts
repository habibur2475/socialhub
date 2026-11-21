/**
 * Account persistence.
 *
 * SQL lives here and nowhere else: the application layer depends on the
 * interface below, so the storage engine (Postgres today, sharded Postgres
 * tomorrow) is a construction-time concern rather than a domain rule.
 *
 * Every statement is parameterised; no value is ever interpolated into SQL.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type { AccountState, AccountType } from '@socialhub/kernel';

export type AccountRow = {
  readonly id: string;
  readonly accountType: AccountType;
  readonly state: AccountState;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly phone: string | null;
  readonly passwordHash: string | null;
  readonly mfaEnabledAt: Date | null;
  readonly sessionEpoch: number;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
};

type RawAccountRow = {
  id: string;
  account_type: AccountType;
  state: AccountState;
  email: string;
  email_verified_at: Date | null;
  phone: string | null;
  password_hash: string | null;
  mfa_enabled_at: Date | null;
  session_epoch: number;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
};

const toAccount = (row: RawAccountRow): AccountRow => ({
  id: row.id,
  accountType: row.account_type,
  state: row.state,
  email: row.email,
  emailVerifiedAt: row.email_verified_at,
  phone: row.phone,
  passwordHash: row.password_hash,
  mfaEnabledAt: row.mfa_enabled_at,
  sessionEpoch: row.session_epoch,
  failedLoginCount: row.failed_login_count,
  lockedUntil: row.locked_until,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

const COLUMNS = `
  id, account_type, state, email, email_verified_at, phone, password_hash,
  mfa_enabled_at, session_epoch, failed_login_count, locked_until, last_login_at, created_at
`;

export type NewAccount = {
  readonly id: string;
  readonly accountType: AccountType;
  readonly state: AccountState;
  readonly email: string;
  readonly passwordHash: string;
};

export type AccountRepository = {
  insert(account: NewAccount): Promise<AccountRow>;
  findById(id: string): Promise<AccountRow | null>;
  findByEmail(email: string): Promise<AccountRow | null>;
  /**
   * Records a failed authentication atomically and locks the account once the
   * threshold is crossed. Returns the post-increment counter.
   */
  registerFailedLogin(id: string, threshold: number, lockForSeconds: number): Promise<number>;
  registerSuccessfulLogin(id: string, at: Date): Promise<void>;
  markEmailVerified(id: string): Promise<boolean>;
  replacePasswordHash(id: string, hash: string): Promise<void>;
  updateState(id: string, state: AccountState): Promise<void>;
  emailExists(email: string): Promise<boolean>;
};

@Injectable()
export class PostgresAccountRepository implements AccountRepository {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async insert(account: NewAccount): Promise<AccountRow> {
    const { rows } = await this.db().query<RawAccountRow>(
      `INSERT INTO accounts (id, account_type, state, email, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [account.id, account.accountType, account.state, account.email, account.passwordHash],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('Account insert returned no row');
    return toAccount(row);
  }

  public async findById(id: string): Promise<AccountRow | null> {
    const { rows } = await this.db().query<RawAccountRow>(
      `SELECT ${COLUMNS} FROM accounts WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toAccount(row);
  }

  public async findByEmail(email: string): Promise<AccountRow | null> {
    const { rows } = await this.db().query<RawAccountRow>(
      `SELECT ${COLUMNS} FROM accounts WHERE email = $1 AND deleted_at IS NULL`,
      [email],
    );
    const row = rows[0];
    return row === undefined ? null : toAccount(row);
  }

  public async emailExists(email: string): Promise<boolean> {
    const { rowCount } = await this.db().query(
      'SELECT 1 FROM accounts WHERE email = $1 AND deleted_at IS NULL',
      [email],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Single-statement increment + conditional lock. Doing this in SQL rather than
   * read-modify-write keeps the counter correct under concurrent attempts, which
   * is exactly the situation an attacker creates.
   */
  public async registerFailedLogin(
    id: string,
    threshold: number,
    lockForSeconds: number,
  ): Promise<number> {
    const { rows } = await this.db().query<{ failed_login_count: number }>(
      `UPDATE accounts
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE
                WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(secs => $3)
                ELSE locked_until
              END
        WHERE id = $1
        RETURNING failed_login_count`,
      [id, threshold, lockForSeconds],
    );
    return rows[0]?.failed_login_count ?? 0;
  }

  public async registerSuccessfulLogin(id: string, at: Date): Promise<void> {
    await this.db().query(
      `UPDATE accounts
          SET failed_login_count = 0, locked_until = NULL, last_login_at = $2
        WHERE id = $1`,
      [id, at],
    );
  }

  public async markEmailVerified(id: string): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `UPDATE accounts
          SET email_verified_at = COALESCE(email_verified_at, now()),
              state = CASE WHEN state = 'PENDING_VERIFICATION' THEN 'ACTIVE' ELSE state END
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  public async replacePasswordHash(id: string, hash: string): Promise<void> {
    await this.db().query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [id, hash]);
  }

  public async updateState(id: string, state: AccountState): Promise<void> {
    await this.db().query('UPDATE accounts SET state = $2 WHERE id = $1 AND deleted_at IS NULL', [
      id,
      state,
    ]);
  }
}

/** Runs a repository call on a specific transaction client (for multi-row invariants). */
export type TransactionalAccountStore = {
  insert(client: PoolClient, account: NewAccount): Promise<AccountRow>;
};

export const transactionalAccountStore: TransactionalAccountStore = {
  async insert(client, account) {
    const { rows } = await client.query<RawAccountRow>(
      `INSERT INTO accounts (id, account_type, state, email, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [account.id, account.accountType, account.state, account.email, account.passwordHash],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('Account insert returned no row');
    return toAccount(row);
  },
};

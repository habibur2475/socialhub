/**
 * Minimal, exact Postgres migration runner.
 *
 * Why not a framework: migrations here are plain SQL files that must be
 * reviewable by a DBA and runnable by an operator with nothing but `psql`. The
 * runner adds only what SQL alone cannot give us — ordering, a ledger table, a
 * checksum guard against edited history, and an advisory lock so two deploys
 * cannot race.
 *
 * Guarantees:
 *   * Files run in lexical order, each in its own transaction (unless the file
 *     declares `-- migrate:no-transaction` for statements like CREATE INDEX
 *     CONCURRENTLY).
 *   * A recorded migration whose checksum changed is a hard error.
 *   * Only one runner proceeds at a time, cluster-wide, via advisory lock.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';

/** Arbitrary but fixed: identifies the migration lock across the whole cluster. */
const ADVISORY_LOCK_KEY = 7_132_004_219;

/**
 * Resolved from this module's own URL rather than the process CWD. SQL files
 * live next to the runner in `src/` and are shipped verbatim, so the same
 * location works under tsx and in a production image.
 */
const MIGRATIONS_DIR =
  process.env['MIGRATIONS_DIR'] ?? join(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    bytea NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL
  );
`;

export type MigrationFile = {
  readonly name: string;
  readonly sql: string;
  readonly checksum: Buffer;
  readonly transactional: boolean;
};

export type MigrationState = {
  readonly applied: ReadonlyMap<string, Buffer>;
  readonly pending: readonly MigrationFile[];
};

const checksumOf = (sql: string): Buffer =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest();

export const loadMigrations = async (
  directory: string = MIGRATIONS_DIR,
): Promise<readonly MigrationFile[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));

  const migrations: MigrationFile[] = [];
  for (const name of files) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`Migration name must match NNNN_snake_case.sql, received: ${name}`);
    }
    const sql = await readFile(join(directory, name), 'utf8');
    migrations.push({
      name,
      sql,
      checksum: checksumOf(sql),
      transactional: !sql.includes('-- migrate:no-transaction'),
    });
  }
  return migrations;
};

export const readState = async (client: PoolClient): Promise<MigrationState> => {
  await client.query(LEDGER_DDL);
  const { rows } = await client.query<{ name: string; checksum: Buffer }>(
    'SELECT name, checksum FROM schema_migrations ORDER BY name',
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  const files = await loadMigrations();
  return { applied, pending: files.filter((file) => !applied.has(file.name)) };
};

export type ApplyReport = {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
};

/**
 * Applies every pending migration. Caller owns the client so it can be a pool
 * checkout or a dedicated connection; the caller must not have an open
 * transaction.
 */
export const applyMigrations = async (client: PoolClient): Promise<ApplyReport> => {
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  const appliedNow: string[] = [];
  const skipped: string[] = [];
  try {
    const state = await readState(client);

    for (const [name, checksum] of state.applied) {
      const file = (await loadMigrations()).find((candidate) => candidate.name === name);
      if (file !== undefined && !file.checksum.equals(checksum)) {
        throw new Error(`Checksum mismatch for applied migration ${name}: history was edited`);
      }
    }

    for (const file of state.pending) {
      const startedAt = process.hrtime.bigint();
      if (file.transactional) await client.query('BEGIN');
      try {
        await client.query(file.sql);
        const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.name, file.checksum, durationMs],
        );
        if (file.transactional) await client.query('COMMIT');
        appliedNow.push(file.name);
      } catch (error) {
        if (file.transactional) await client.query('ROLLBACK');
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.name} failed: ${reason}`, { cause: error });
      }
    }

    for (const name of state.applied.keys()) skipped.push(name);
    return { applied: appliedNow, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
};

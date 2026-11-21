/**
 * CLI: report migration state without applying anything.
 * Usage: DATABASE_URL=postgres://... pnpm db:status
 */
import { Pool } from 'pg';
import { readState } from '../migrator.js';

const run = async (): Promise<void> => {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const state = await readState(client);
    process.stdout.write(`applied: ${state.applied.size}\n`);
    for (const name of state.pending) process.stdout.write(`pending  ${name}\n`);
    if (state.pending.length === 0) process.stdout.write('schema is up to date\n');
  } finally {
    client.release();
    await pool.end();
  }
};

await run();

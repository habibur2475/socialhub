/**
 * CLI: apply pending migrations.
 * Usage: DATABASE_URL=postgres://... pnpm db:migrate
 */
import { Pool } from 'pg';
import { applyMigrations } from '../migrator.js';

const run = async (): Promise<void> => {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const report = await applyMigrations(client);
    if (report.applied.length === 0) {
      process.stdout.write(`No pending migrations (${report.skipped.length} already applied).\n`);
      return;
    }
    for (const name of report.applied) process.stdout.write(`applied  ${name}\n`);
    process.stdout.write(`\n${report.applied.length} migration(s) applied.\n`);
  } finally {
    client.release();
    await pool.end();
  }
};

await run();

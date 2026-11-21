/**
 * CLI: provision a development database.
 *
 * Creates the application role and database if they are absent, then applies
 * migrations. Idempotent: safe to run on every `docker compose up`.
 *
 * Usage: DATABASE_URL=postgres://postgres@localhost:5432/postgres pnpm db:setup
 */

import { Pool } from 'pg';
import { applyMigrations } from '../migrator.js';

const ADMIN_URL = process.env['DATABASE_URL'];
const APP_DATABASE = process.env['APP_DATABASE'] ?? 'socialhub';
const APP_ROLE = process.env['APP_ROLE'] ?? 'socialhub_app';
const APP_PASSWORD = process.env['APP_PASSWORD'] ?? 'socialhub_dev_password';

const quoteIdent = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const run = async (): Promise<void> => {
  if (ADMIN_URL === undefined || ADMIN_URL.length === 0) {
    throw new Error('DATABASE_URL (admin connection) is required');
  }

  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    const roleExists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (roleExists.rowCount === 0) {
      await admin.query(
        `CREATE ROLE ${quoteIdent(APP_ROLE)} LOGIN PASSWORD ${quoteLiteral(APP_PASSWORD)}`,
      );
      process.stdout.write(`created role ${APP_ROLE}\n`);
    }

    const databaseExists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      APP_DATABASE,
    ]);
    if (databaseExists.rowCount === 0) {
      await admin.query(
        `CREATE DATABASE ${quoteIdent(APP_DATABASE)} OWNER ${quoteIdent(APP_ROLE)}`,
      );
      process.stdout.write(`created database ${APP_DATABASE}\n`);
    }
  } finally {
    await admin.end();
  }

  const appUrl = new URL(ADMIN_URL);
  appUrl.pathname = `/${APP_DATABASE}`;
  const pool = new Pool({ connectionString: appUrl.toString(), max: 1 });
  const client = await pool.connect();
  try {
    // Extensions require superuser on managed clusters; the setup path runs as admin.
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "citext"');

    const report = await applyMigrations(client);
    process.stdout.write(
      report.applied.length === 0
        ? `schema up to date (${report.skipped.length} migrations)\n`
        : `applied ${report.applied.length} migration(s)\n`,
    );

    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(APP_ROLE)}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdent(APP_ROLE)}`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(APP_ROLE)}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(APP_ROLE)}`,
    );

    // The ledger is append-only at the database level, so the application role
    // receives no UPDATE/DELETE on it. Triggers enforce this too; revoking the
    // grant removes even the opportunity.
    await client.query(`REVOKE UPDATE, DELETE ON audit_events FROM ${quoteIdent(APP_ROLE)}`);

    process.stdout.write('privileges granted\n');
  } finally {
    client.release();
    await pool.end();
  }
};

await run();

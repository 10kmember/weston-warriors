/**
 * PostgreSQL access.
 *
 * Every query in this codebase goes through here and every one of them is
 * parameterised. There is no string interpolation of user input into SQL
 * anywhere in the app, which is the only reliable way to be done with
 * injection as a class of bug.
 */

import pg from 'pg';
import { config } from './config.js';

// Return money columns as integers rather than strings. `int8`/bigint stays a
// string by default (it can exceed Number.MAX_SAFE_INTEGER); we only use it for
// audit_log ids, where a string is fine.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

/**
 * Supabase (and most managed Postgres) require TLS, and their pooler presents a
 * certificate for a shared hostname that the public CA chain does not vouch for
 * per-project. We therefore encrypt but do not verify, which is what
 * `?sslmode=require` means to libpq too. Set DATABASE_CA to a PEM to verify
 * properly.
 */
function sslOptions() {
  if (config.databaseCa) return { ca: config.databaseCa, rejectUnauthorized: true };
  if (config.databaseSsl) return { rejectUnauthorized: false };
  return false;
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: sslOptions(),
  // One connection per instance on serverless: every warm lambda holds its own
  // pool, and Supabase's transaction pooler is what does the real pooling.
  max: config.isServerless ? 1 : 10,
  idleTimeoutMillis: config.isServerless ? 10_000 : 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

/** Run a query and return the rows. */
export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

/** Run a query expecting at most one row. */
export async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 * The callback receives a client with the same `query`/`one` shape.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const api = {
      query: async (text, params = []) => (await client.query(text, params)).rows,
      one: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
    };
    const result = await fn(api);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}

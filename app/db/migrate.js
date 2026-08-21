/**
 * Migration runner. Applies every .sql file in db/migrations that is not
 * already recorded in schema_migrations, in filename order.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'migrations');

async function applied(client) {
  try {
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    return new Set(rows.map((r) => r.version));
  } catch {
    return new Set();   // table does not exist yet
  }
}

export async function migrate() {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    const done = await applied(client);
    let ran = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      process.stdout.write(`  applying ${version} … `);
      await client.query(sql);
      console.log('done');
      ran += 1;
    }
    console.log(ran ? `[migrate] applied ${ran} migration(s)` : '[migrate] already up to date');
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('[migrate] failed:', err.message);
      await pool.end();
      process.exit(1);
    });
}

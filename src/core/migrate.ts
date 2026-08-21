/**
 * Migration runner. Applies every migrations/*.sql in filename order inside a
 * transaction, guarded by a session advisory lock so concurrent container starts
 * cannot race each other (review: the guide left this as "simplest: psql loop").
 *
 * Migrations are written to be idempotent, so re-running is safe.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool, closePool } from './db.js';
import { logger } from './logger.js';

const LOCK_KEY = 728_100_1; // arbitrary but stable

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/core -> repo root, and dist/core -> repo root when built
  return resolve(here, '..', '..', 'migrations');
}

export async function runMigrations(): Promise<string[]> {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      logger.info({ file }, 'applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    // Keep the rolling partition window fresh on every boot.
    await client.query('SELECT ensure_audit_partitions(2)');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (isEntrypoint) {
  runMigrations()
    .then((files) => {
      logger.info({ count: files.length, files }, 'migrations complete');
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err: Error) => {
      logger.error({ err: err.message }, 'migrations failed');
      process.exit(1);
    });
}

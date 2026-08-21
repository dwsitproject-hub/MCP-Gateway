/**
 * Postgres access. Single pool, used by the OAuth store, user store and audit writer.
 */
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { cfg } from './config.js';
import { logger } from './logger.js';

/**
 * TLS to the database.
 *
 * The store is a managed ApsaraDB instance reached across the VPC, not a container on
 * the compose network, so this connection carries OAuth tokens and the whole audit
 * trail over a real network path.
 *
 * Built explicitly rather than left to `?sslmode=` in the URL: driver interpretation
 * of that parameter is subtle, and the failure mode is a plaintext connection that
 * looks perfectly healthy.
 */
function sslConfig(): PoolConfig['ssl'] {
  switch (cfg.DATABASE_SSL) {
    case 'disable':
      return undefined;
    case 'verify-full': {
      // config.ts refuses to boot if the path is missing.
      const ca = readFileSync(cfg.DATABASE_CA_PATH as string, 'utf8');
      return { rejectUnauthorized: true, ca };
    }
    case 'require':
    default:
      // Encrypted, but the server certificate is not authenticated.
      return { rejectUnauthorized: false };
  }
}

/**
 * Pin the schema for every connection.
 *
 * All migration and runtime SQL uses unqualified names (`oauth_clients`,
 * `audit_events`, and the partitions `ensure_audit_partitions()` creates at runtime),
 * so they land wherever `search_path` points. On a managed instance that default is
 * not ours to assume - observed on ApsaraDB, where a session resolved an unqualified
 * CREATE TABLE into `information_schema` and failed with a permission error that
 * reads like the role is wrong rather than the path.
 *
 * Sent as a startup parameter, so it is in force before the first statement rather
 * than after a SET that some pooled connection might miss.
 */
const SCHEMA_OPTIONS = '-c search_path=public';

export const pool = new Pool({
  connectionString: cfg.DATABASE_URL,
  options: SCHEMA_OPTIONS,
  ...(cfg.DATABASE_SSL === 'disable' ? {} : { ssl: sslConfig() }),
  max: 10,
  idleTimeoutMillis: 30_000,
  // A managed endpoint across the VPC is slower to accept than a container on the
  // same bridge, and TLS adds a handshake.
  connectionTimeoutMillis: 10_000,
  application_name: 'mcp-gateway',
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'idle postgres client error');
});

export async function query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(sql, params as unknown[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function isReachable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm the connection can actually create objects in the schema it will use.
 * Ownership metadata and effective privilege are different things, and the failure
 * otherwise surfaces halfway through migration 001.
 */
export async function assertSchemaUsable(): Promise<void> {
  const rows = await query<{ search_path: string; usr: string; db: string }>(
    'SELECT current_setting($1) AS search_path, current_user AS usr, current_database() AS db',
    ['search_path'],
  );
  const info = rows[0];
  logger.info(
    { searchPath: info?.search_path, user: info?.usr, database: info?.db },
    'database connection established',
  );

  try {
    await query('CREATE TABLE IF NOT EXISTS public._mcp_perm_check (id int)');
    await query('DROP TABLE IF EXISTS public._mcp_perm_check');
  } catch (err) {
    throw new Error(
      `the database role cannot create objects in schema public (${(err as Error).message}). ` +
        'Run: ALTER SCHEMA public OWNER TO <role>;  -- since PostgreSQL 15, owning the ' +
        'database does not grant CREATE on its public schema.',
    );
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

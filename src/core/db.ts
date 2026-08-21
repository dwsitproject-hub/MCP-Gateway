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

export const pool = new Pool({
  connectionString: cfg.DATABASE_URL,
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

export async function closePool(): Promise<void> {
  await pool.end();
}

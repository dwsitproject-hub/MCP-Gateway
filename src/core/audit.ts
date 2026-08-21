/**
 * Append-only audit writer (PRD S4/G3, TSD Section 9.1).
 *
 * Design rules:
 *  - 100% of tool calls, success and failure, are recorded with the human identity.
 *  - Parameter values matching credential patterns are redacted before storage (S5).
 *  - The store is append-only at the database level; this module never updates a row.
 *  - Fail closed: if the audit write fails, the caller must abort the tool call rather
 *    than serve an unattributable answer (review H9.4). PRD Section 12 asks for
 *    "degrade by queueing, not by dropping" - a bounded in-memory retry queue absorbs
 *    a brief blip, and exhausting it surfaces AUDIT_UNAVAILABLE.
 */
import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { logger } from './logger.js';
import { cfg } from './config.js';
import { auditUnavailable } from './errors.js';

export type AuditEvent =
  | 'tool_request'
  | 'tool_outcome'
  | 'auth_login'
  | 'auth_fail'
  | 'token_issued'
  | 'token_revoked'
  | 'guard_block'
  | 'admin_action';

export interface AuditContext {
  requestId: string;
  userId: string;
  clientIp?: string | undefined;
  oauthClientId?: string | undefined;
}

export interface AuditRecord {
  event: AuditEvent;
  ctx: AuditContext;
  tool?: string | undefined;
  params?: unknown;
  klipCalls?: unknown;
  rowCount?: number | undefined;
  latencyMs?: number | undefined;
  outcome?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

const CREDENTIAL_KEY = /(pass|password|secret|token|credential|authorization|apikey|api_key|code_verifier)/i;
/** Values that look like a bearer token, JWT or long random string get masked regardless of key. */
const CREDENTIAL_VALUE = /^(bearer\s+)?[A-Za-z0-9_\-]{24,}\.?[A-Za-z0-9_\-.]*$/;
const MAX_FREE_TEXT = 512;

/** Recursively redact anything that looks like a credential (S5). */
export function redact(value: unknown, keyHint = ''): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (CREDENTIAL_KEY.test(keyHint)) return '[redacted]';
    if (value.length >= 24 && CREDENTIAL_VALUE.test(value)) return '[redacted]';
    return value.length > MAX_FREE_TEXT ? `${value.slice(0, MAX_FREE_TEXT)}...[truncated]` : value;
  }
  // Numbers and booleans are never credentials. Redacting by key alone destroyed
  // useful audit content: the kill switch records detail.refresh_tokens as a COUNT,
  // and the key matched /token/ so the count was stored as "[redacted]".
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, keyHint));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = CREDENTIAL_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redact(v, k);
    }
    return out;
  }
  return String(value);
}

const INSERT = `
  INSERT INTO audit_events
    (ts, request_id, user_id, client_ip, oauth_client_id, event, tool, params, klip_calls,
     row_count, latency_ms, outcome, detail)
  VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`;

interface QueuedWrite {
  params: unknown[];
  attempts: number;
}

const MAX_QUEUE = 500;
const retryQueue: QueuedWrite[] = [];
let draining = false;

async function insert(params: unknown[]): Promise<void> {
  await query(INSERT, params);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (retryQueue.length > 0) {
      const head = retryQueue[0];
      if (head === undefined) break;
      try {
        await insert(head.params);
        retryQueue.shift();
      } catch {
        break; // still unavailable; leave the queue intact for the next attempt
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Write one audit row. Throws AUDIT_UNAVAILABLE only when the write cannot be
 * accepted at all (store down and queue full), so callers fail closed.
 */
export async function write(record: AuditRecord): Promise<void> {
  const detail = { ...(record.detail ?? {}), klip_env: cfg.KLIP_ENV };
  const params: unknown[] = [
    record.ctx.requestId,
    record.ctx.userId,
    record.ctx.clientIp ?? null,
    record.ctx.oauthClientId ?? null,
    record.event,
    record.tool ?? null,
    record.params === undefined ? null : JSON.stringify(redact(record.params)),
    record.klipCalls === undefined ? null : JSON.stringify(record.klipCalls),
    record.rowCount ?? null,
    record.latencyMs ?? null,
    record.outcome ?? null,
    JSON.stringify(redact(detail)),
  ];

  try {
    await insert(params);
    if (retryQueue.length > 0) void drain();
  } catch (err) {
    logger.error({ err: (err as Error).message, event: record.event }, 'audit write failed');
    if (retryQueue.length >= MAX_QUEUE) throw auditUnavailable();
    retryQueue.push({ params, attempts: 1 });
    // A queued write is not yet durable. Anything that must be attributable
    // before proceeding (tool_request) treats this as a failure.
    if (record.event === 'tool_request') throw auditUnavailable();
  }
}

export function newRequestId(): string {
  return randomUUID();
}

export function queueDepth(): number {
  return retryQueue.length;
}

/** Health signal: the audit writer is healthy when nothing is backed up. */
export function isHealthy(): boolean {
  return retryQueue.length === 0;
}

export async function flush(): Promise<void> {
  await drain();
}

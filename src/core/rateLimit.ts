/**
 * Per-user token bucket (TSD Section 10 / Section 14).
 *
 * Keyed on the OAuth subject, NOT the client IP. Every request arrives from
 * Anthropic's egress pool, so IP-keyed limiting would put the whole pilot in one
 * bucket (review B7). nginx keeps a much looser IP-level anti-abuse floor.
 */
import { cfg } from './config.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export interface Decision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function check(subject: string, now = Date.now()): Decision {
  const { calls, windowSeconds } = cfg.RATE_LIMIT_USER;
  const refillPerMs = calls / (windowSeconds * 1000);

  let bucket = buckets.get(subject);
  if (bucket === undefined) {
    bucket = { tokens: calls, lastRefill: now };
    buckets.set(subject, bucket);
  }

  const elapsed = Math.max(0, now - bucket.lastRefill);
  bucket.tokens = Math.min(calls, bucket.tokens + elapsed * refillPerMs);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
  }

  const deficit = 1 - bucket.tokens;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(deficit / refillPerMs / 1000)),
  };
}

export function reset(): void {
  buckets.clear();
}

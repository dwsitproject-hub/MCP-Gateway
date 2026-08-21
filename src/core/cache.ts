/**
 * Short-lived read cache (review H5).
 *
 * klip_outstanding walks up to KLIP_MAX_PAGES pages per call; without a cache the
 * P95 <= 5 s target is not reachable and repeat questions re-walk the same data.
 * The cached entry keeps its ORIGINAL fetch timestamp, which the result envelope
 * surfaces as as_of - so a cached answer is honest about its age rather than
 * pretending to be fresh.
 */
import { cfg } from './config.js';

interface Entry<T> {
  value: T;
  /** When the underlying data was actually fetched from KLIP. */
  fetchedAt: Date;
  expiresAt: number;
}

export interface Cached<T> {
  value: T;
  fetchedAt: Date;
  fromCache: boolean;
}

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 200;

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  // Oldest-inserted first; Map preserves insertion order.
  const oldest = store.keys().next();
  if (!oldest.done) store.delete(oldest.value);
}

export function purgeExpired(now = Date.now()): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

/**
 * Return a cached value or produce it. TTL of 0 disables caching entirely.
 */
export async function through<T>(key: string, produce: () => Promise<T>): Promise<Cached<T>> {
  const ttlMs = cfg.CACHE_TTL_SECONDS * 1000;
  if (ttlMs === 0) {
    return { value: await produce(), fetchedAt: new Date(), fromCache: false };
  }

  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit !== undefined && hit.expiresAt > now) {
    return { value: hit.value, fetchedAt: hit.fetchedAt, fromCache: true };
  }

  const fetchedAt = new Date();
  const value = await produce();
  store.set(key, { value, fetchedAt, expiresAt: now + ttlMs });
  evictIfNeeded();
  return { value, fetchedAt, fromCache: false };
}

export function keyFor(tool: string, params: Record<string, unknown>): string {
  const normalised = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${String(params[k]).toLowerCase()}`)
    .join('&');
  return `${cfg.KLIP_ENV}:${tool}?${normalised}`;
}

export function clear(): void {
  store.clear();
}

export function size(): number {
  return store.size;
}

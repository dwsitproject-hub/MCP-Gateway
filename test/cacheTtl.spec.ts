/**
 * Per-call cache TTL: one expensive tool (klip_outstanding_breakdown) keeps its result
 * longer than CACHE_TTL_SECONDS, and CACHE_TTL_SECONDS=0 still turns every cache off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ CACHE_TTL_SECONDS: 60 }));
vi.mock('../src/core/config.js', () => ({ cfg }));

const cache = await import('../src/core/cache.js');

afterEach(() => { vi.useRealTimers(); cache.clear(); cfg.CACHE_TTL_SECONDS = 60; });

describe('cache.through ttlSeconds', () => {
  it('keeps an overridden entry past the global TTL, until its own runs out', async () => {
    vi.useFakeTimers();
    const produce = vi.fn().mockResolvedValue(1);
    await cache.through('k', produce, { ttlSeconds: 300 });
    vi.advanceTimersByTime(120_000);
    expect((await cache.through('k', produce, { ttlSeconds: 300 })).fromCache).toBe(true);
    vi.advanceTimersByTime(181_000);
    expect((await cache.through('k', produce, { ttlSeconds: 300 })).fromCache).toBe(false);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('without an override uses CACHE_TTL_SECONDS as before', async () => {
    vi.useFakeTimers();
    const produce = vi.fn().mockResolvedValue(1);
    await cache.through('g', produce);
    vi.advanceTimersByTime(61_000);
    expect((await cache.through('g', produce)).fromCache).toBe(false);
  });

  it('CACHE_TTL_SECONDS=0 disables the override too', async () => {
    cfg.CACHE_TTL_SECONDS = 0;
    const produce = vi.fn().mockResolvedValue(1);
    await cache.through('z', produce, { ttlSeconds: 300 });
    expect((await cache.through('z', produce, { ttlSeconds: 300 })).fromCache).toBe(false);
    expect(produce).toHaveBeenCalledTimes(2);
  });
});

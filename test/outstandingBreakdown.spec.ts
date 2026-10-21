/**
 * klip_outstanding_breakdown: a plant x incoterm table in one call, every cell KLIP's own
 * aggregate. What these pin:
 *   - each cell is a GET to /contracts/late-performance/summary WITH scope=filtered and that
 *     cell's filters (the scope gate is the bug that shipped once; the mock reproduces it);
 *   - only combinations that exist in the contract list are asked about;
 *   - KLIP's whole-product total is reported beside the cells, and a mismatch is named, not fixed;
 *   - nothing but GETs reaches KLIP (apart from its sign-in).
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.outstandingBreakdown;
let server: Server;
let state: MockState;
let tool: (typeof import('../src/tools/klip/outstandingBreakdown.js'))['outstandingBreakdown'];
let cache: typeof import('../src/core/cache.js');
const ctx = { requestId: 'test-request', userId: 'tester@example.com' };

async function run(args: Record<string, unknown>) {
  const parsed = z.strictObject(tool.inputShape).parse(args);
  return tool.handler(parsed as never, ctx);
}

beforeAll(async () => {
  process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
  process.env.KLIP_ENV = 'staging';
  process.env.CACHE_TTL_SECONDS = '0';
  process.env.KLIP_MAX_PAGES = '10';
  process.env.KLIP_PAGE_SIZE = '100';
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  tool = (await import('../src/tools/klip/outstandingBreakdown.js')).outstandingBreakdown;
  cache = await import('../src/core/cache.js');
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { state.requests.length = 0; cache.clear(); });

const summaryCalls = () => state.requests.filter((r) => r.path === '/api/contracts/late-performance/summary');

describe('klip_outstanding_breakdown', () => {
  it('asks KLIP once per existing plant x incoterm cell, every time with scope=filtered', async () => {
    const out = await run({ by: 'plant_incoterm' });
    const data = out.data as { cells: Array<{ plant: string; incoterm: string }>; cells_with_contracts: number };
    const plants = new Set(state.contracts.map((c) => c.plant_site));
    expect(data.cells_with_contracts).toBeGreaterThan(0);
    expect(data.cells_with_contracts).toBeLessThanOrEqual(plants.size * 4 + 4);
    const calls = summaryCalls();
    // one whole-product call plus one per cell
    expect(calls).toHaveLength(data.cells_with_contracts + 1);
    for (const c of calls.slice(1)) {
      expect(c.query.scope).toBe('filtered');
      expect(c.query.plant).toBeTruthy();
      expect(c.query.incoterms).toBeTruthy();
    }
    // Read-only: GETs only, apart from KLIP's own sign-in.
    for (const r of state.requests) if (r.method !== 'GET') expect(r.path).toBe('/api/auth/login');
    expect(out.units).toBe('MT');
  });

  it('splits by incoterm only, without a plant filter', async () => {
    const out = await run({ by: 'incoterm' });
    for (const c of summaryCalls().slice(1)) {
      expect(c.query.plant).toBeUndefined();
      expect(c.query.incoterms).toBeTruthy();
    }
    expect((out.data as { cells: unknown[] }).cells.length).toBeGreaterThan(0);
  });

  it('reports KLIP\'s total beside the cells and names a mismatch instead of fixing it', async () => {
    const out = await run({ by: 'plant' });
    const data = out.data as {
      total: { open_outstanding_mt: number } | null;
      reconciliation: { sum_of_cells_open_mt: number; total_open_mt: number; cells_add_up_to_total: boolean | null; note: string };
    };
    expect(data.total).not.toBeNull();
    expect(data.reconciliation.total_open_mt).toBe(data.total!.open_outstanding_mt);
    // The mock answers every filtered query with the same figure, so the parts cannot add up.
    expect(data.reconciliation.cells_add_up_to_total).toBe(false);
    expect(data.reconciliation.note).toMatch(/do not adjust/);
  });

  it('defaults to year to date, like the KLIP page, and sends no dates when all_time is asked', async () => {
    await run({ by: 'plant' });
    const year = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 4);
    for (const c of summaryCalls()) expect(c.query.dateFrom).toBe(`${year}-01-01`);
    state.requests.length = 0; cache.clear();
    const out = await run({ by: 'plant', all_time: true });
    for (const c of summaryCalls()) expect(c.query.dateFrom).toBeUndefined();
    expect((out.data as { period: string }).period).toMatch(/All time/);
  });

  it('refuses a product KLIP does not know, before any aggregate call', async () => {
    await expect(run({ product: 'Unobtainium' })).rejects.toThrow();
    expect(summaryCalls()).toHaveLength(0);
  });
});

/**
 * klip_shipping_performance, rebuilt against the actual KLIP page.
 *
 * The first version had the right endpoint and the wrong shape - one flat population,
 * averaged across every row. The page uses TWO cohorts measured on different clocks:
 * on-going voyages against estimates, completed ones against actuals. Averaging across
 * them mixes a forecast with a record, and it did.
 *
 * Verified against the page's own cards on 28 Aug 2026: 107 on-going, 263 completed,
 * and the card values reproduce exactly once the sign is restored.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.shippingPerformance;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let tool: typeof import('../src/tools/klip/shippingPerformance.js')['shippingPerformance'];

const ctx = { requestId: 'ship-perf', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  tool = (await import('../src/tools/klip/shippingPerformance.js')).shippingPerformance;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = async (args: Record<string, unknown> = {}) =>
  (await tool.handler({ limit: 10, cohort: 'both', ...args } as never, ctx)).data as Record<string, any>;

describe('the two cohorts', () => {
  it('splits on status COMPLETED, the way the page does', async () => {
    const d = await run();
    expect(d.completed.shipments).toBe(1);
    expect(d.on_going.shipments).toBe(2);
  });

  it('measures each cohort on its own clock', async () => {
    const d = await run();
    expect(d.on_going.basis).toMatch(/estimated/i);
    expect(d.completed.basis).toMatch(/actual/i);
  });

  it('reads the ACTUAL delta family for completed voyages', async () => {
    // The mock populates only ata_* on the completed row. Reading the estimate family
    // there - as the first version did - would return null and report it as unmeasured.
    const d = await run();
    expect(d.completed.total.days).toBe(-8);
    expect(d.completed.load_readiness.days).toBe(10);
  });

  it('reads the ESTIMATE family for on-going voyages', async () => {
    const d = await run();
    expect(d.on_going.total.days).toBe(6);
    expect(d.on_going.load_readiness.days).toBe(7);
  });

  it('labels each shipment with the cohort it was measured in', async () => {
    const d = await run();
    const byId = Object.fromEntries(d.shipments.map((s: any) => [s.sto_number ?? s.contract_number, s.cohort]));
    expect(Object.values(byId)).toContain('completed');
    expect(Object.values(byId)).toContain('on_going');
  });

  it('returns one cohort when asked for one', async () => {
    const d = await run({ cohort: 'completed' });
    expect(d.shipments).toHaveLength(1);
    expect(d.shipments[0].cohort).toBe('completed');
  });
});

describe('what it refuses to flatten', () => {
  it('keeps the SIGN the page throws away', async () => {
    // The page renders "2 days" where the data holds -2, and most deltas are negative -
    // events BEFORE estimate. A fleet running early and one running late must not read
    // the same.
    const d = await run();
    expect(d.on_going.load_arrival_to_berth.days).toBe(-2);
    expect(d.completed.discharge_berth_to_complete.days).toBe(-7);
    expect(String(d.sign_note)).toMatch(/Do not describe a negative figure as a delay/i);
  });

  it('averages only over shipments carrying the measurement, and says how many', async () => {
    const d = await run();
    // Two on-going rows, one with figures. A mean over both would count the unmeasured
    // one as zero, which reads as on time.
    expect(d.on_going.shipments).toBe(2);
    expect(d.on_going.total.measured_on).toBe(1);
    expect(String(d.coverage_note)).toMatch(/UNMEASURED, not on time/i);
  });

  it('reports null rather than zero when a cohort has no measurement at all', async () => {
    const d = await run({ vessel_name: 'no-such-vessel' });
    expect(d.on_going.total.days).toBeNull();
    expect(d.on_going.total.measured_on).toBe(0);
  });

  it('counts distinct vessels separately from shipments', async () => {
    // The page labels its row count "Total Vessels"; they are not the same number.
    const d = await run();
    expect(d.on_going).toHaveProperty('distinct_vessels');
    expect(d.completed.distinct_vessels).toBeLessThanOrEqual(d.completed.shipments);
  });

  it('asserts no completeness, because KLIP reports no total here', async () => {
    const out = await tool.handler({ limit: 10, cohort: 'both' } as never, ctx);
    expect(out.coverage?.total_rows).toBeNull();
  });
});

describe('filters and units', () => {
  it('sends plant to KLIP, the one filter it applies', async () => {
    await run({ plant: 'Bontang' });
    const call = state.requests.filter((r) => r.path === '/api/shipments/performance').pop();
    expect(call?.query.plant).toBe('Bontang');
  });

  it('applies vessel locally, and offers no period control that does nothing', async () => {
    const d = await run({ vessel_name: 'BIO EXPRESS' });
    expect(d.shipments).toHaveLength(1);
    expect(Object.keys(tool.inputShape)).not.toContain('period');
    expect(Object.keys(tool.inputShape)).not.toContain('scope');
    expect(String(d.filters_applied_locally)).toMatch(/no working period filter/i);
  });

  it('converts quantities from the kilograms KLIP holds', async () => {
    const d = await run({ cohort: 'completed' });
    expect(d.shipments[0].contract_qty_mt).toBe(1200);
  });
});

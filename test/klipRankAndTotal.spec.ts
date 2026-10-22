/**
 * Ranking and totalling done by the gateway itself, with no new KLIP request options:
 *   - klip_top_contracts ranks open contracts by KLIP's own outstanding, with contract date;
 *   - klip_unassigned_outstanding totals, per plant, contracts with no shipment plus the STO
 *     quantity of shipments with no vessel - never the repeated per-STO outstanding;
 *   - klip_shipping_performance leaves no-shipment contracts out of the voyage figures and
 *     ranks across every shipment fetched before applying the limit.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.klipRankAndTotal;
let server: Server;
let state: MockState;
type Mods = {
  top: (typeof import('../src/tools/klip/topContracts.js'))['topContracts'];
  unassigned: (typeof import('../src/tools/klip/unassignedOutstanding.js'))['unassignedOutstanding'];
  perf: (typeof import('../src/tools/klip/shippingPerformance.js'))['shippingPerformance'];
  cache: typeof import('../src/core/cache.js');
};
let m: Mods;
const ctx = { requestId: 'test-request', userId: 'tester@example.com' };
async function run(tool: { inputShape: z.ZodRawShape; handler: (p: never, c: never) => Promise<unknown> }, args: Record<string, unknown> = {}) {
  const parsed = z.strictObject(tool.inputShape).parse(args);
  return ((await tool.handler(parsed as never, ctx as never)) as { data: Record<string, any> }).data;
}

beforeAll(async () => {
  process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
  process.env.KLIP_ENV = 'staging';
  process.env.CACHE_TTL_SECONDS = '0';
  process.env.KLIP_MAX_PAGES = '10';
  process.env.KLIP_PAGE_SIZE = '100';
  state = freshState();
  state.perfExtras = true;
  // The generated contracts carry no outstanding_quantity; give them KLIP-style values (kg strings).
  state.contracts.forEach((c, i) => { (c as unknown as Record<string, string>).outstanding_quantity = String(((i * 37) % 11) * 100_000) + '.00'; });
  ({ server } = await startMockKlip(PORT, state));
  m = {
    top: (await import('../src/tools/klip/topContracts.js')).topContracts,
    unassigned: (await import('../src/tools/klip/unassignedOutstanding.js')).unassignedOutstanding,
    perf: (await import('../src/tools/klip/shippingPerformance.js')).shippingPerformance,
    cache: await import('../src/core/cache.js'),
  };
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { state.requests.length = 0; m.cache.clear(); });

describe('klip_top_contracts', () => {
  it('ranks open contracts by KLIP outstanding, largest first, with the latest contract', async () => {
    // The mock speaks KLIP's older status vocabulary (ACTIVE); production is Open/Close.
    const d = await run(m.top as never, { status: 'ACTIVE', limit: 25 });
    const os = d.contracts.map((c: any) => c.outstanding_mt);
    expect(os.length).toBeGreaterThan(0);
    expect([...os].sort((a: number, b: number) => b - a)).toEqual(os);
    expect(os.every((v: number) => v > 0)).toBe(true);
    const dates = d.contracts.map((c: any) => c.contract_date).filter(Boolean).sort();
    if (d.latest_contract && dates.length) expect(d.latest_contract.contract_date >= dates[0]).toBe(true);
    expect(d.top_suppliers.length).toBeGreaterThan(0);
  });

  it('sends the status filter upstream and fetches at KLIP\'s page maximum', async () => {
    await run(m.top as never, { status: 'ACTIVE' });
    // The last contracts call is the ranking walk; the first one is the filter-name check.
    const call = [...state.requests].reverse().find((r) => r.path === '/api/contracts');
    expect(call?.query.status).toBe('ACTIVE');
    expect(Number(call?.query.limit)).toBe(1000);
  });
});

describe('klip_unassigned_outstanding', () => {
  it('totals contracts with no shipment and shipments with no vessel, per plant', async () => {
    const d = await run(m.unassigned as never, { product: 'CPO' });
    const tjp = d.plants.find((p: any) => p.plant === 'TJP');
    expect(tjp.not_on_any_shipment_mt).toBe(750);      // the backlog row's outstanding
    expect(tjp.contracts_not_on_any_shipment).toBe(1);
    // SP-7 is PLANNED with no vessel: KLIP's apportioned outstanding (300 MT) is counted - not its
    // sto_qty (400) and not the contract figure that repeats on every STO (1,000).
    expect(tjp.on_shipment_without_vessel_mt).toBe(300);
    expect(tjp.shipments_without_vessel).toBe(1);
    expect(tjp.without_vessel_mt).toBe(1050);
    // SP-3 carries no apportioned outstanding: left out, and the result says so rather than
    // falling back to the repeated per-row figure.
    expect(d.rows_not_counted).toMatch(/^1 open shipment/);
    expect(d.top_suppliers_not_on_any_shipment[0]).toEqual({ supplier: 'BACKLOG SUPPLIER PT.', outstanding_mt: 750 });
    expect(d.plants.find((p: any) => p.plant === 'Bontang')).toBeUndefined();
  });
});

describe('klip_shipping_performance', () => {
  it('leaves contracts with no shipment out of the voyage figures', async () => {
    const d = await run(m.perf as never, { cohort: 'both' });
    expect(d.contracts_without_shipment_excluded).toBe(1);
    expect(d.shipments.some((s: any) => s.status === 'UNPLANNED')).toBe(false);
  });

  it('ranks by total duration across every shipment before the limit', async () => {
    const d = await run(m.perf as never, { cohort: 'on_going', rank_by: 'total_days', limit: 1 });
    expect(d.shipments).toHaveLength(1);
    expect(d.shipments[0].vessel_name).toBe('MT. LONG HAUL');
    expect(String(d.ranked_by)).toMatch(/every shipment fetched/);
  });

  it('gives one line per vessel for a "top N vessels" question, as the page By Vessel view does', async () => {
    // Ranking shipment rows alone let MT. LONG HAUL take two of the top three with two STOs.
    const d = await run(m.perf as never, { cohort: 'on_going', rank_by: 'total_days', limit: 3 });
    const names = d.top_vessels.map((v: any) => v.vessel_name);
    expect(new Set(names).size).toBe(names.length);
    expect(d.top_vessels[0]).toMatchObject({ vessel_name: 'MT. LONG HAUL', shipments: 2, avg_total_days: -14, total_measured_on: 2, outstanding_mt: 600 });
    expect(d.shipments.filter((s: any) => s.vessel_name === 'MT. LONG HAUL')).toHaveLength(2);
  });

  it('does not describe KLIP Total as a voyage duration', async () => {
    const d = await run(m.perf as never, { rank_by: 'total_days' });
    expect(d.sign_note).toMatch(/not the length of the voyage/);
    expect(String(d.ranked_by)).not.toMatch(/duration/);
    expect(m.perf.description).toMatch(/not the length of the voyage/);
  });
});

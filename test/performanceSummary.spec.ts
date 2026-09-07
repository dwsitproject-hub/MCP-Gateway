/**
 * klip_performance_summary.
 *
 * The endpoint honours two of the thirteen filters KLIP documented. Everything worth
 * testing here follows from that: the tool must not offer a filter KLIP discards, and it
 * must say whose arithmetic produced the figures, because klip_outstanding computes its
 * own and the two may disagree.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.performanceSummary;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let tool: typeof import('../src/tools/klip/performanceSummary.js')['performanceSummary'];

const ctx = { requestId: 'perf-summary', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  tool = (await import('../src/tools/klip/performanceSummary.js')).performanceSummary;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the summary itself', () => {
  it('reads the LATE cohort, cycle times and lateness buckets', async () => {
    // `summary` is the late cohort, not every contract - its count equals
    // open_late + close_late. Named all_contracts here originally, which is the
    // misreading the field name itself invited.
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(d.late_contracts.count).toBe(254);
    expect(d.late_contracts.avgLogCycle).toBe(12);
    expect(d.lateness_distribution.d61plus.count).toBe(1);
  });

  it('is never marked truncated, because KLIP aggregates the whole set', async () => {
    const out = await tool.handler({} as never, ctx);
    expect(out.truncated).toBe(false);
  });

  it('actually sends the filters it accepts', async () => {
    const out = await tool.handler({ transport_mode: 'SEA' } as never, ctx);
    const d = out.data as Record<string, any>;
    // The mock narrows only when a working parameter arrives, so a changed count proves
    // the query string was sent rather than built and dropped.
    expect(d.late_contracts.count).toBe(40);
    expect(String(d.filters_applied)).toContain('transportMode');
  });
});

describe('the filters it offers, and the one it does not', () => {
  it('offers exactly the parameters KLIP demonstrably applies', async () => {
    // A parameter absent from the schema is a visible limitation; one that silently does
    // nothing is not. status was absent on that reasoning until 7 Sep 2026, when
    // watching the page showed it sending status=Open against /late-performance/data -
    // so it does work, for those exact strings. breakdown_depth arrived with the same
    // discovery: /data returns KLIP's drilldown trees that /summary does not.
    expect(Object.keys(tool.inputShape)).toEqual([
      'date_from',
      'date_to',
      'transport_mode',
      'plant',
      'supplier',
      'product',
      'incoterm',
      'search',
      'status',
      'breakdown_depth',
    ]);
  });

  it('explains the one dimension it cannot narrow', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(String(d.filters_unavailable)).toMatch(/No contract-status filter/);
    expect(String(d.filters_unavailable)).toMatch(/splits every figure into open and closed/);
  });

  it('says the figures are company-wide when nothing narrowed them', async () => {
    const out = await tool.handler({} as never, ctx);
    expect(String((out.data as Record<string, any>).filters_applied)).toMatch(/company-wide/i);
  });
});

describe('attribution and units', () => {
  it('names KLIP as the source of the arithmetic, and warns against mixing', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(String(d.computed_by)).toContain('klip_outstanding');
    expect(String(d.computed_by)).toMatch(/without saying which produced which/i);
  });

  it('converts every quantity to MT and leaves counts and day figures alone', async () => {
    /**
     * This tool used to report kilograms raw under "the unit is NOT confirmed". A live
     * chat on 4 Sep 2026 duly published 391,988,806 and refused to call it tonnes; the
     * user then compared it with the page, where the same figure renders as 419,223 MT
     * against a tool reading of 419,223,245. The ratio was settled twice over.
     *
     * The conversion keys off "qty" in the field name, so the risk this test guards is
     * the opposite error: dividing a COUNT or a DAY figure by 1,000, which would be far
     * worse than reporting kilograms.
     */
    const out = await tool.handler({} as never, ctx);
    expect(out.units).toBe('MT');

    const d = out.data as Record<string, any>;

    // Unfiltered mock: n = 254, so openOutstandingQty is 127,000 kg.
    expect(d.late_contracts.openOutstandingQty).toBe(127);
    expect(d.late_contracts.totalQtyDelivery).toBe(254);
    expect(d.all_contracts_by_status.openOutstandingQty).toBe(127);
    expect(d.lateness_distribution.onTime.qty).toBe(1);

    // Untouched: counts, durations and cycle days carry no "qty" in their names.
    expect(d.late_contracts.count).toBe(254);
    expect(d.late_contracts.avgLogCycle).toBe(12);
    expect(d.late_contracts.maxDays).toBe(61);
    expect(d.all_contracts_by_status.openAvgLogCycle).toBe(12);
    expect(d.all_contracts_by_status.openLateCount).toBe(5);
    expect(d.lateness_distribution.onTime.count).toBe(10);

    expect(String(d.units_note)).toMatch(/METRIC TONNES/);
  });
});

describe('the drilldown', () => {
  it("returns KLIP's nested breakdown, in MT, with each level named", async () => {
    // The question a live chat could not answer: CPO outstanding per plant, incoterm
    // and supplier. It needed hundreds of calls because this tool only read /summary;
    // /late-performance/data carries the whole tree in one response.
    const out = await tool.handler({ breakdown_depth: 2 } as never, ctx);
    const d = out.data as Record<string, any>;

    expect(d.breakdown_levels).toEqual(['incoterm', 'group_plant']);

    const top = d.late_breakdown[0];
    // Level names count DOWN from the top, not up from the maximum depth - labelling a
    // two-level request `supplier_group` was the first version of this.
    expect(top.level).toBe('incoterm');
    expect(top.key).toBe('FOB');
    expect(top.contracts).toBe(12);
    expect(top.qty_delivered_mt).toBe(12_000); // 12,000,000 kg

    expect(top.children[0].level).toBe('group_plant');
    expect(top.children[0].key).toBe('BONTANG');
    expect(top.children[0].qty_delivered_mt).toBe(8_000);
    // Pruned at the requested depth, so no product level below.
    expect(top.children[0].children).toBeUndefined();

    // The bucket that is in neither the late nor the on-track counters.
    expect(d.unscheduled_breakdown[0].key).toBe('CIF');
    expect(d.unscheduled_breakdown[0].contracts).toBe(3);
    expect(String(d.breakdown_note)).toMatch(/does not re-pivot/);
  });

  it('asks for no tree at all by default', async () => {
    // /summary rather than /data, so a caller wanting only the cards does not pay for
    // a five-level tree.
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(d.late_breakdown).toBeUndefined();
    expect(d.breakdown_levels).toBeUndefined();
  });
});

describe('the scope=filtered gate', () => {
  it('sends scope=filtered whenever a gated filter is set', async () => {
    // Derived, not remembered. Without it KLIP returns the unfiltered YTD figures under
    // the caller's plant filter - company-wide numbers labelled as one plant.
    const out = await tool.handler({ plant: 'TJP' } as never, ctx);
    expect((out.data as Record<string, any>).late_contracts.count).toBe(40);
    const q = state.requests.filter((r) => r.path.includes('late-performance')).pop();
    expect(q?.query.scope).toBe('filtered');
    expect(q?.query.plant).toBe('TJP');
  });

  it('sends it for every gated filter, not just plant', async () => {
    for (const [key, value] of [
      ['supplier', 'Supplier A'],
      ['product', 'CPO'],
      ['incoterm', 'FOB'],
      ['search', 'anything'],
    ] as const) {
      const out = await tool.handler({ [key]: value } as never, ctx);
      expect((out.data as Record<string, any>).late_contracts.count).toBe(40);
    }
  });

  it('does NOT send it when only ungated filters are used', async () => {
    // transportMode and the dates work with or without the gate; adding it would change
    // the meaning of the date window rather than leaving it alone.
    await tool.handler({ transport_mode: 'SEA' } as never, ctx);
    const q = state.requests.filter((r) => r.path.includes('late-performance')).pop();
    expect(q?.query.scope).toBeUndefined();
    expect(q?.query.transportMode).toBe('SEA');
  });

  it('offers the status filter KLIP actually honours, as an enum', async () => {
    // KLIP accepts Open and Close exactly - any other casing matches nothing upstream
    // and returns zeros rather than an error, so the enum is enforced on this side.
    // The page itself sends status=Open, which is how we found it.
    expect(Object.keys(tool.inputShape)).toContain('status');
    await expect(
      (async () => {
        const { z } = await import('zod');
        return z.strictObject(tool.inputShape).parse({ status: 'open' });
      })(),
    ).rejects.toThrow(/Invalid option/);
  });

  it('still explains the status filter rather than leaving it a mystery', async () => {
    const out = await tool.handler({} as never, ctx);
    expect(String((out.data as Record<string, any>).filters_unavailable)).toMatch(/only for the exact strings/i);
  });
});

describe('the two cohorts are kept apart', () => {
  it('names the late cohort as late, not as all contracts', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(d.late_contracts).not.toBeNull();
    expect(d.all_contracts).toBeUndefined();
  });

  it('reports every contract separately, split by status', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(d.all_contracts_by_status).not.toBeNull();
    expect(String(d.cohort_note)).toMatch(/DIFFERENT POPULATIONS/);
  });
});

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
    // nothing is not. status is absent for that reason - see the gate suite below.
    expect(Object.keys(tool.inputShape)).toEqual([
      'date_from',
      'date_to',
      'transport_mode',
      'plant',
      'supplier',
      'product',
      'incoterm',
      'search',
    ]);
  });

  it('explains the one dimension it cannot narrow', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(String(d.filters_unavailable)).toMatch(/No contract-status filter/);
    expect(String(d.filters_unavailable)).toMatch(/split into open and closed/);
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

  it('claims no unit for the quantities', async () => {
    const out = await tool.handler({} as never, ctx);
    expect(out.units).toBeNull();
    expect(String((out.data as Record<string, any>).units_note)).toMatch(/NOT confirmed/);
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

  it('still offers no contract-status filter', async () => {
    // scope=filtered&status=Open leaves all four card counts unchanged on live KLIP,
    // so it is a filter that would silently do nothing.
    expect(Object.keys(tool.inputShape)).not.toContain('status');
    const out = await tool.handler({} as never, ctx);
    expect(String((out.data as Record<string, any>).filters_unavailable)).toMatch(/does not narrow/i);
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
    expect(String(d.cohort_note)).toMatch(/Never read the first as a plant total/i);
  });
});

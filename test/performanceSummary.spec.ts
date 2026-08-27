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
  it('reads the aggregate object, cycle times and lateness buckets', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(d.all_contracts.count).toBe(254);
    expect(d.all_contracts.avgLogCycle).toBe(12);
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
    expect(d.all_contracts.count).toBe(40);
    expect(String(d.filters_applied)).toContain('transportMode');
  });
});

describe('the filters it refuses to pretend to support', () => {
  it('has no plant, incoterm, status, supplier or product parameter', async () => {
    // Accepting one KLIP discards would return company-wide figures labelled as one
    // plant. A parameter absent from the schema is a visible limitation; one that
    // silently does nothing is not.
    const keys = Object.keys(tool.inputShape);
    expect(keys).toEqual(['date_from', 'date_to', 'transport_mode']);
    for (const forbidden of ['plant', 'incoterm', 'incoterms', 'status', 'supplier', 'product']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('says which dimensions cannot be broken down here, and where to go instead', async () => {
    const out = await tool.handler({} as never, ctx);
    const d = out.data as Record<string, any>;
    expect(String(d.filters_unavailable)).toMatch(/KLIP ignores plant, incoterm, status/);
    expect(String(d.filters_unavailable)).toContain('klip_outstanding');
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

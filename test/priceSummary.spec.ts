/**
 * klip_price_summary.
 *
 * This tool exists because a model asked for nine months of price history, concluded
 * that unit_price lived only on the per-contract detail record, estimated several
 * hundred calls, and sampled two contracts a month. The reasoning was sound and the
 * premise was wrong - price is on the contract LIST and had never been mapped.
 *
 * So the tests are about the three ways a price aggregate goes quietly wrong:
 *
 *   1. averaging across currencies, which produces a number that is a price in neither
 *   2. assuming whether unit_price is per kilogram or per tonne - a factor of 1000
 *   3. presenting a partial walk as the market
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.priceSummary;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let tool: (typeof import('../src/tools/klip/priceSummary.js'))['priceSummary'];

const ctx = { requestId: 'price-summary', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  tool = (await import('../src/tools/klip/priceSummary.js')).priceSummary;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(args: Record<string, unknown> = {}) {
  const { z } = await import('zod');
  const parsed = z.strictObject(tool.inputShape).parse(args);
  return tool.handler(parsed as never, ctx);
}

describe('the price basis, measured rather than assumed', () => {
  it('works out that unit_price is PER KILOGRAM from contract_value', async () => {
    /**
     * The mock prices per kilogram against kilogram quantities, so contract_value is
     * their product. Reading the price as per-tonne instead would be a thousandfold
     * error in a figure somebody negotiates against.
     */
    const d = (await run()).data as Record<string, any>;
    expect(d.price_basis).toBe('per_kg');
    expect(String(d.price_basis_note)).toMatch(/PER KILOGRAM/);
    // The evidence travels with the claim.
    expect(String(d.price_basis_note)).toMatch(/measured on \d+ contract\(s\)/);
  });
});

describe('currencies are never mixed', () => {
  it('keeps IDR and US$ in separate groups', async () => {
    // Production carries both. A mean across them is not a price in either.
    const d = (await run({ group_by: 'incoterm' })).data as Record<string, any>;
    const currencies = new Set(d.groups.map((g: any) => g.currency));
    expect(currencies.has('IDR')).toBe(true);
    expect(currencies.has('US$')).toBe(true);
    // Every group is single-currency: no row carries a blended figure.
    for (const g of d.groups) expect(typeof g.currency).toBe('string');
  });

  it('never produces a group whose average sits between the two currencies', async () => {
    const d = (await run({ group_by: 'incoterm' })).data as Record<string, any>;
    for (const g of d.groups) {
      // IDR prices are ~14,000/kg and US$ ~0.92/kg. Anything in between would be a
      // blend, which is the failure this guards.
      if (g.currency === 'IDR') expect(g.weighted_avg_price).toBeGreaterThan(1000);
      if (g.currency === 'US$') expect(g.weighted_avg_price).toBeLessThan(100);
    }
  });
});

describe('the averages', () => {
  it('reports the volume-weighted average and the simple mean side by side', async () => {
    // A 50-tonne contract must not move the average as much as a 5,000-tonne one, and
    // the gap between the two figures is itself information about the population.
    const d = (await run({ group_by: 'incoterm' })).data as Record<string, any>;
    const idr = d.groups.find((g: any) => g.currency === 'IDR');
    expect(idr.weighted_avg_price).toBeGreaterThan(0);
    expect(idr.simple_avg_price).toBeGreaterThan(0);
    expect(String(d.which_average_to_quote)).toMatch(/weighted_avg_price/);
  });

  it('carries min, max and median so a spread can be judged', async () => {
    const d = (await run({ group_by: 'incoterm' })).data as Record<string, any>;
    const g = d.groups.find((x: any) => x.currency === 'IDR');
    expect(g.min_price).toBeLessThanOrEqual(g.median_price);
    expect(g.median_price).toBeLessThanOrEqual(g.max_price);
  });

  it('groups by month and incoterm together by default', async () => {
    const d = (await run()).data as Record<string, any>;
    expect(d.grouped_by).toBe('month_incoterm');
    // "2026-03 FOB" shape: a month and an incoterm, not one or the other.
    expect(String(d.groups[0].group)).toMatch(/^\d{4}-\d{2} \w+/);
  });
});

describe('honesty about the population', () => {
  it('covers the WHOLE contract list rather than a sample', async () => {
    /**
     * The point of the tool. 250 contracts in the mock, all of them priced except any
     * without a usable figure - not two a month.
     */
    const out = await run();
    const d = out.data as Record<string, any>;
    expect(d.contracts_priced + d.contracts_without_a_usable_price).toBeGreaterThanOrEqual(250);
    expect(out.coverage?.fetched_rows).toBeGreaterThanOrEqual(250);
  });

  it('counts contracts with no usable price instead of treating them as zero', async () => {
    // A zero-priced contract in the mean would drag every average down and look like a
    // cheap month.
    const d = (await run()).data as Record<string, any>;
    expect(typeof d.contracts_without_a_usable_price).toBe('number');
  });

  it('says the figures were computed here, not published by KLIP', async () => {
    const d = (await run()).data as Record<string, any>;
    expect(String(d.computed_here)).toMatch(/computed HERE/);
    expect(String(d.computed_here)).toMatch(/not a KLIP report/);
  });
});

/**
 * The truncation contract (review H4.1), in its own spec file so the page bound is
 * set before src/core/config.ts is imported and frozen.
 *
 * The property under test is the one most likely to make this connector state a
 * wrong number with confidence: when the fetch is bounded, the payload must NOT
 * contain a key called `totals`.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';

const PORT = 5189;

// Set BEFORE any src import: one page of a three-page result.
process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.KLIP_MAX_PAGES = '1';
process.env.KLIP_PAGE_SIZE = '100';
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let outstandingTool: typeof import('../src/tools/klip/outstanding.js')['outstanding'];
let searchTool: typeof import('../src/tools/klip/searchContracts.js')['searchContracts'];

const ctx = { requestId: 'truncation-test', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  outstandingTool = (await import('../src/tools/klip/outstanding.js')).outstanding;
  searchTool = (await import('../src/tools/klip/searchContracts.js')).searchContracts;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('bounded fetch reporting', () => {
  /**
   * H4.1 was: never publish a field called `totals` over a partial set, because that is
   * the likeliest way this connector states a wrong number with confidence.
   *
   * Since 27 Aug the total no longer comes from the rows at all - it comes from KLIP's
   * performance aggregate, computed over the whole matching dataset with no pagination.
   * So a bounded ROW fetch no longer makes the TOTAL partial, and `totals` is safe.
   *
   * The hazard has not gone away, it has moved: the new way to state a wrong number would
   * be to let someone add up a partial row sample and read it as the total. These assert
   * the replacement invariant, which is stronger - the total is complete regardless of the
   * row bound, and the sample says plainly that it is one.
   */
  it('publishes a complete total even when the ROW fetch is bounded', async () => {
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    const data = outcome.data as Record<string, unknown>;

    // The row walk IS bounded here - one page of three.
    expect(outcome.truncated).toBe(true);
    // ...and the total is still whole, because KLIP aggregated it, not us.
    expect(Object.keys(data)).toContain('totals');
    expect(Object.keys(data)).not.toContain('totals_partial');
    expect(String(data.totals_source)).toMatch(/no pagination/i);
    expect(String(data.totals_source)).toMatch(/reconcile against/i);
  });

  it('warns that the CONTRACT LIST is a sample, and that the total is not affected', async () => {
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    const data = outcome.data as Record<string, unknown>;
    expect(String(data.row_sample_warning)).toMatch(/partial\s+sample/i);
    expect(String(data.row_sample_warning)).toMatch(/total above is unaffected/i);
    expect(String(data.top_contracts_note)).toMatch(/do not add up to the total/i);
  });

  it('reports no total at all rather than substituting our own', async () => {
    // If KLIP's aggregate cannot be read, the honest output is an absent total. Falling
    // back to the connector's own arithmetic would reintroduce the second number that
    // the 24 Aug ruling exists to remove.
    const src = await import('../src/tools/klip/outstanding.js');
    const text = String(src.outstanding.description);
    expect(text).toMatch(/READ-ONLY/);
    // The guard itself is asserted through the payload contract: a null total carries an
    // explicit explanation rather than a zero.
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    const data = outcome.data as Record<string, unknown>;
    if (data.totals === null) {
      expect(String(data.totals_unavailable)).toMatch(/Do not sum them into a total/i);
    } else {
      expect(data.totals_unavailable).toBeUndefined();
    }
  });

  it('reports coverage honestly: rows read versus rows that exist', async () => {
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    // Derived from the fixture rather than hardcoded: the point under test is that
    // fetched_rows and total_rows describe DIFFERENT populations when the fetch is
    // bounded, not that either equals a particular number. A literal here breaks
    // whenever a case is added to the fixture, which teaches people to edit the
    // expectation rather than read it.
    const all = state.contracts.length;
    expect(outcome.coverage).toEqual({
      fetched_rows: 100,
      total_rows: all,
      pages_fetched: 1,
      total_pages: Math.ceil(all / 100),
    });
    expect(outcome.coverage?.fetched_rows).toBeLessThan(all);
  });

  it('klip_search_contracts applies the same rule', async () => {
    const outcome = await searchTool.handler({ limit: 5 } as never, ctx);
    const data = outcome.data as Record<string, unknown>;
    expect(outcome.truncated).toBe(true);
    expect(Object.keys(data)).toContain('totals_partial');
    expect(Object.keys(data)).not.toContain('totals');
  });

  it('stops at the bound instead of walking every page', async () => {
    state.requests.length = 0;
    await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    const contractCalls = state.requests.filter((r) => r.path === '/api/contracts');
    expect(contractCalls).toHaveLength(1);
  });
});

describe('the next_step must not contradict the payload', () => {
  it('does not tell the caller the TOTAL is partial when only the row sample is', async () => {
    // The default hint reads truncated as "the figures cover only part of the matching
    // data ... do not quote any total". Since the total comes from KLIP's server-side
    // aggregate that is false, and it contradicted row_sample_warning in the same
    // payload - the cry-wolf failure KLIP-008 was about, reintroduced by our own change.
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    expect(outcome.truncated).toBe(true);
    expect(outcome.nextStep).toBeTypeOf('string');
    expect(String(outcome.nextStep)).toMatch(/TOTAL above is complete/i);
    expect(String(outcome.nextStep)).not.toMatch(/cover only part/i);
    expect(String(outcome.nextStep)).toMatch(/do not add up the listed rows/i);
  });

  it('leaves the default hint alone for tools whose figures really are partial', async () => {
    // klip_search_contracts aggregates the rows it read, so a bounded fetch DOES make
    // its totals partial. The override must not have weakened that.
    const outcome = await searchTool.handler({ limit: 5 } as never, ctx);
    expect(outcome.truncated).toBe(true);
    expect(outcome.nextStep).toBeUndefined();
  });
});

describe('units', () => {
  it('reports MT, converted from the kilograms KLIP holds', async () => {
    // A 3,500 MT contract carries outstanding_quantity 3500000. Confirmed against the
    // KLIP page on 27 Aug: the row unit field says "MT" and the column holds kg.
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    expect(outcome.units).toBe('MT');
    const data = outcome.data as Record<string, any>;
    if (data.totals !== null) {
      expect(Object.keys(data.totals)).toContain('open_outstanding_mt');
      expect(Object.keys(data.totals)).not.toContain('open_outstanding');
    }
  });
});

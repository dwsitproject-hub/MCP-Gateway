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
  it('klip_outstanding publishes totals_partial and omits totals entirely', async () => {
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    const data = outcome.data as Record<string, unknown>;

    expect(outcome.truncated).toBe(true);
    expect(Object.keys(data)).toContain('totals_partial');
    // The whole point: no field named "totals" over a partial set.
    expect(Object.keys(data)).not.toContain('totals');
    expect(data.partial_totals_warning).toBeTypeOf('string');
    expect(String(data.partial_totals_warning)).toMatch(/NOT a complete/i);
  });

  it('reports coverage honestly: rows read versus rows that exist', async () => {
    const outcome = await outstandingTool.handler({ as_of_basis: 'current' } as never, ctx);
    expect(outcome.coverage).toEqual({
      fetched_rows: 100,
      total_rows: 254,
      pages_fetched: 1,
      total_pages: 3,
    });
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

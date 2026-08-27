/**
 * `truncated` must mean COVERAGE, not display (KLIP-008).
 *
 * The envelope attaches "the figures cover only part of the matching data" whenever
 * truncated is true. Six tools used to also set it when more rows were FETCHED than
 * SHOWN - a completely different fact, under which the aggregates are complete and
 * only the row list is shortened. Live calls carried that warning on results with
 * 235 of 235 rows and 3 of 3 pages.
 *
 * The cost is not the false positive. It is that a warning which fires on complete
 * results stops being read on partial ones, where it is load-bearing.
 *
 * The page bound is deliberately generous here so the fetch is always COMPLETE;
 * the variable under test is the display limit.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.coverageWarning;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.KLIP_MAX_PAGES = '50';   // never bound: coverage is always complete
process.env.KLIP_PAGE_SIZE = '100';
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let searchTool: typeof import('../src/tools/klip/searchContracts.js')['searchContracts'];

const ctx = { requestId: 'coverage-test', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  searchTool = (await import('../src/tools/klip/searchContracts.js')).searchContracts;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a complete fetch shown in part', () => {
  it('is NOT reported as truncated, and carries no narrow-the-filter hint', async () => {
    // limit=5 against a mock holding hundreds: every matching row is fetched,
    // only five are listed.
    const out = await searchTool.handler({ limit: 5 } as never, ctx);
    expect(out.truncated).toBe(false);
  });

  it('still states the display bound, so a short list is not mistaken for a short result', async () => {
    const out = await searchTool.handler({ limit: 5 } as never, ctx);
    const data = out.data as { rows_shown: number; totals?: { matching_contracts: number } };
    expect(data.rows_shown).toBe(5);
    // The aggregate covers every matching contract, not the five displayed - which is
    // the whole reason suppressing the warning is safe.
    expect(data.totals?.matching_contracts).toBeGreaterThan(5);
  });

  it('publishes `totals`, not `totals_partial`, because coverage IS complete', async () => {
    const out = await searchTool.handler({ limit: 5 } as never, ctx);
    expect(out.data).toHaveProperty('totals');
    expect(out.data).not.toHaveProperty('totals_partial');
  });
});

/**
 * The single-contract envelope is NESTED, and differs from the list envelope.
 *
 *   detail:  data.{ contract, shipments, payments, matched_by, match_count }
 *   list:    data.{ contracts, pagination }
 *
 * fetchOne unwrapped `data` unconditionally, which handed the caller the WRAPPER. Every
 * field then resolved to null against a record that was present and fully populated, and
 * the absent-record guard passed because the object had keys. klip_get_contract reported
 * contract_id "(unknown)" with every field null for a contract that klip_search_contracts
 * returned in full - found by the KLIP team probing this connector on 27 Aug 2026.
 *
 * These assert the shape rather than the values, because the failure is a silent one:
 * every HTTP call succeeds and the tool returns a well-formed object.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.detailEnvelope;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.KLIP_MAX_PAGES = '5';
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let getContract: typeof import('../src/tools/klip/getContract.js')['getContract'];

const ctx = { requestId: 'detail-envelope', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  getContract = (await import('../src/tools/klip/getContract.js')).getContract;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ID = '4700010001';

describe('the nested detail record', () => {
  it('reads through data.contract, not data', async () => {
    const out = await getContract.handler({ contract_id: ID } as never, ctx);
    const c = (out.data as { contract: { contract_id: string | null; supplier: string | null } }).contract;
    // The exact failure that shipped: an identifier the tool could not read.
    expect(c.contract_id).not.toBe('(unknown)');
    expect(c.contract_id).toBe(ID);
    expect(c.supplier).not.toBeNull();
  });

  it('populates quantities rather than nulling them against a present record', async () => {
    const out = await getContract.handler({ contract_id: ID } as never, ctx);
    const c = (out.data as { contract: { qty_po_mt: number | null } }).contract;
    expect(c.qty_po_mt).not.toBeNull();
    expect(c.qty_po_mt).toBeGreaterThan(0);
  });

  it('uses the INLINE linked lists instead of reporting them unavailable', async () => {
    const out = await getContract.handler({ contract_id: ID } as never, ctx);
    const data = out.data as { shipments: unknown[]; payments: unknown[]; incomplete_sections?: string[] };
    expect(data.shipments.length).toBeGreaterThan(0);
    expect(data.payments.length).toBeGreaterThan(0);
    // The stale note claimed KLIP had no contract filter. It always had one.
    const sections = (data.incomplete_sections ?? []).join(' ');
    expect(sections).not.toContain('KLIP exposes no contract filter');
    expect(sections).not.toContain('2026-08-21');
  });

  it('still raises NOT_FOUND for an identifier that matches nothing', async () => {
    await expect(
      getContract.handler({ contract_id: 'no-such-contract' } as never, ctx),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('an identifier matching several contracts', () => {
  it('warns that the record is one of several rather than presenting it as the answer', async () => {
    // PO-2026-SHARED covers two contracts, as happens under multi-STO. KLIP returns one.
    const out = await getContract.handler({ contract_id: 'PO-2026-SHARED' } as never, ctx);
    const data = out.data as { match_warning?: string; match_count?: number };
    expect(data.match_count).toBe(2);
    expect(data.match_warning).toContain('one of several');
    // The figures below belong to ONE contract; quoting them as the PO total is the
    // error this warning exists to prevent.
    expect(data.match_warning).toContain('ask the user which contract');
  });

  it('reports match_count and matched_by so a unique hit is distinguishable', async () => {
    const out = await getContract.handler({ contract_id: ID } as never, ctx);
    const data = out.data as { match_count?: number; matched_by?: string };
    expect(data.match_count).toBe(1);
    expect(data.matched_by).toBe('uuid');
  });
});

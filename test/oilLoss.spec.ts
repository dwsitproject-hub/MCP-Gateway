/**
 * klip_oil_loss.
 *
 * The properties worth pinning are all about restraint: this endpoint tempts the
 * connector into three claims it cannot support.
 *
 *   1. It has no pagination and reports no total, so completeness cannot be asserted.
 *   2. It mixes units and labels only some of them, so nothing may be converted.
 *   3. It carries a populated quantity_sent, contradicting KLIP-004's finding that sent
 *      weight exists nowhere - which makes surfacing it tempting and premature.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.oilLoss;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let tool: typeof import('../src/tools/klip/oilLoss.js')['oilLoss'];

const ctx = { requestId: 'oil-loss', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  tool = (await import('../src/tools/klip/oilLoss.js')).oilLoss;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('reading the unusual envelope', () => {
  it('finds rows despite there being no success wrapper and no pagination', async () => {
    const out = await tool.handler({ limit: 20 } as never, ctx);
    const data = out.data as { movements: Array<{ operation_id: string | null }> };
    expect(data.movements.length).toBe(2);
    expect(data.movements[0]?.operation_id).toBe('OP-1');
  });

  it('carries the contract join, which is the linkage KLIP-001 is about', async () => {
    const out = await tool.handler({ limit: 20 } as never, ctx);
    const m = (out.data as { movements: Array<Record<string, unknown>> }).movements[0]!;
    expect(m.contract_number).toBe('4700010001');
    expect(m.sto_number).toBe('STO-88001');
    expect(m.po_number).toBe('PO-2026-0001');
  });
});

describe('claims the tool must not make', () => {
  it('does NOT label the quantities with a unit', async () => {
    // KLIP mixes totalGainKg with totalMt on this one endpoint and the row fields carry
    // no suffix. Asserting MT here would be a 1000x error if wrong.
    const out = await tool.handler({ limit: 20 } as never, ctx);
    expect(out.units).toBeNull();
    expect(String((out.data as { units_note: string }).units_note)).toMatch(/NOT confirmed/i);
  });

  it('does not convert the raw figures', async () => {
    const out = await tool.handler({ limit: 20 } as never, ctx);
    const m = (out.data as { movements: Array<{ quantity_dispatched: number | null }> }).movements[0]!;
    // 30000 as KLIP sent it, not 30 tonnes.
    expect(m.quantity_dispatched).toBe(30_000);
  });

  it('reports total_rows as null rather than implying completeness', async () => {
    const out = await tool.handler({ limit: 20 } as never, ctx);
    expect(out.coverage?.total_rows).toBeNull();
    expect(out.coverage?.total_pages).toBeNull();
    expect(String((out.data as { coverage_note: string }).coverage_note)).toMatch(/possibly incomplete/i);
  });

  it('does not surface quantity_sent while its provenance is unconfirmed', async () => {
    // Present and populated on this endpoint, unlike /trucking. Reporting a weighbridge
    // figure on the strength of one payload is the mistake we objected to in KLIP-004.
    const out = await tool.handler({ limit: 20 } as never, ctx);
    expect(JSON.stringify(out.data)).not.toContain('quantity_sent');
  });
});

describe('local filtering', () => {
  it('narrows on transport mode and says the filter was applied locally', async () => {
    const out = await tool.handler({ transport_mode: 'SEA', limit: 20 } as never, ctx);
    const data = out.data as { movements: unknown[]; matching_rows: number; filters_applied_locally: string };
    expect(data.movements.length).toBe(1);
    expect(data.matching_rows).toBe(1);
    expect(data.filters_applied_locally).toMatch(/after fetching/i);
  });

  it('says an empty result may be a spelling problem, not an absence of loss', async () => {
    const out = await tool.handler({ plant: 'no-such-plant', limit: 20 } as never, ctx);
    const data = out.data as { empty_result_note?: string };
    expect(data.empty_result_note).toMatch(/before reporting that no loss was recorded/i);
  });
});

/**
 * klip_shipping_performance.
 *
 * This tool exists because a chat asked about shipment performance and got an essay on
 * contract lateness: there was no shipping tool, so the model reached for the nearest
 * thing. The capability gap is now filled; these pin the properties that keep it from
 * overstating what it knows.
 *
 * On live data 137 of 370 shipments carry a delay figure and 90 have a completed
 * discharge. An average over those is an average over a third of the fleet, so every
 * metric must ship with its denominator.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.shippingPerformance;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let tool: typeof import('../src/tools/klip/shippingPerformance.js')['shippingPerformance'];

const ctx = { requestId: 'ship-perf', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  tool = (await import('../src/tools/klip/shippingPerformance.js')).shippingPerformance;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('planned against actual', () => {
  it('reports KLIP delay figures rather than subtracting timestamps itself', async () => {
    const out = await tool.handler({ limit: 10 } as never, ctx);
    const d = out.data as Record<string, any>;
    // Mean of -8 and 6 over the two shipments that HAVE a figure: -1.
    expect(d.delay_days.total).toBe(-1);
    expect(String(d.computed_by)).toMatch(/does not recompute/i);
  });

  it('carries both the estimated and the actual milestone, not just the gap', async () => {
    const out = await tool.handler({ limit: 10 } as never, ctx);
    const s = (out.data as { shipments: Array<Record<string, unknown>> }).shipments[0]!;
    expect(s.loading_eta_arrival).toBe('2026-07-10');
    expect(s.loading_ata_arrival).toBe('2026-03-12');
    expect(s.vessel_name).toBe('BG. ELANG JAWA 1');
  });

  it('converts quantities from the kilograms KLIP holds', async () => {
    const out = await tool.handler({ limit: 10 } as never, ctx);
    const s = (out.data as { shipments: Array<Record<string, unknown>> }).shipments[0]!;
    expect(s.contract_qty_mt).toBe(1200);
    expect(out.units).toBe('MT');
  });
});

describe('what it refuses to overstate', () => {
  it('averages only over shipments that HAVE a figure, and says how many that was', async () => {
    // Three shipments, two with a delay. A mean over three would treat the unmeasured one
    // as zero - which reads as on time.
    const out = await tool.handler({ limit: 10 } as never, ctx);
    const d = out.data as Record<string, any>;
    expect(d.delay_days.shipments_matched).toBe(3);
    expect(d.delay_days.total_measured_on).toBe(2);
    expect(String(d.coverage_note)).toMatch(/unmeasured, NOT on time/i);
  });

  it('reports total_rows as null, because KLIP gives no total here', async () => {
    const out = await tool.handler({ limit: 10 } as never, ctx);
    expect(out.coverage?.total_rows).toBeNull();
  });

  it('says the always-empty columns are empty rather than reporting them as zero', async () => {
    const out = await tool.handler({ limit: 10 } as never, ctx);
    const json = JSON.stringify(out.data);
    expect(String((out.data as { not_available: string }).not_available)).toMatch(/freight/i);
    expect(json).not.toContain('"freight":0');
    expect(json).not.toContain('"pump_rate":0');
  });
});

describe('filters', () => {
  it('sends plant to KLIP, the one filter it applies', async () => {
    await tool.handler({ plant: 'Bontang', limit: 10 } as never, ctx);
    const call = state.requests.filter((r) => r.path === '/api/shipments/performance').pop();
    expect(call?.query.plant).toBe('Bontang');
  });

  it('applies vessel locally, because KLIP accepts and discards it', async () => {
    const out = await tool.handler({ vessel_name: 'BIO EXPRESS', limit: 10 } as never, ctx);
    const ships = (out.data as { shipments: Array<{ vessel_name: string | null }> }).shipments;
    expect(ships).toHaveLength(1);
    expect(ships[0]?.vessel_name).toBe('MT. BIO EXPRESS');
    expect(String((out.data as { filters_applied_locally: string }).filters_applied_locally))
      .toMatch(/accepted by the endpoint and discarded/i);
  });

  it('matches a shipment by its STO or PO number, not only the contract number', async () => {
    const out = await tool.handler({ contract_number: '1001030752', limit: 10 } as never, ctx);
    expect((out.data as { shipments: unknown[] }).shipments).toHaveLength(1);
  });
});

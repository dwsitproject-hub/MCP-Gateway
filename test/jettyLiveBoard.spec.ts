/**
 * jetty_live_board: the JPS Live Ops dashboard's three widgets, with the dashboard's own
 * rules (DashboardShell.jsx, dashboardArrivalsWindow.js, dashboardSailed.js). Pins:
 *   - the ETC chip: past ETC is "+Nh" and listed in past_etc; unknown ETC is "No ETC";
 *   - waiting = arrived, not alongside, not sailed, not Rejected; oldest first;
 *   - arriving = not arrived; past ETA is overdue and always listed; no ETA falls back to ETB;
 *     outside the window is left out;
 *   - the Sailed tile counts voyages cast off in the last 72 h, once per plan;
 *   - only GETs reach JPS (apart from its login).
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMockJetty, freshJettyState, type MockJettyState } from './fixtures/mockJetty.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.jettyLiveBoard;
let server: Server;
let state: MockJettyState;
let tool: (typeof import('../src/tools/jetty/liveBoard.js'))['jettyLiveBoard'];
let resetJettySession: () => void;
const ctx = { requestId: 'test-request', userId: 'tester@example.com' };

async function run(args: Record<string, unknown> = {}) {
  const parsed = z.strictObject(tool.inputShape).parse(args);
  return (await tool.handler(parsed as never, ctx)).data as Record<string, any>;
}

beforeAll(async () => {
  process.env.JETTY_BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;
  process.env.JETTY_SVC_USER = 'MCP';
  process.env.JETTY_SVC_PASS = 'a-long-enough-password';
  process.env.JETTY_PORT_ID = '1';
  process.env.JETTY_ENV = 'production';
  state = freshJettyState();
  await new Promise<void>((resolve) => { server = createMockJetty(state).listen(PORT, '127.0.0.1', resolve); });
  tool = (await import('../src/tools/jetty/liveBoard.js')).jettyLiveBoard;
  resetJettySession = (await import('../src/adapters/jetty/session.js')).resetJettySession;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { state.requests.length = 0; resetJettySession(); });

describe('at berth now', () => {
  it('reproduces the ETC chip and lists vessels past ETC', async () => {
    const d = await run();
    const giat = d.at_berth.vessels.find((v: any) => v.vessel_name === 'MT. GIAT ARMADA 02');
    expect(giat.etc_state).toBe('over');
    expect(giat.etc_chip).toMatch(/^\+/);
    expect(giat.hours_past_etc).toBeGreaterThan(0);
    expect(d.at_berth.past_etc.map((v: any) => v.vessel_name)).toEqual(['MT. GIAT ARMADA 02']);
    const eiho = d.at_berth.vessels.find((v: any) => v.vessel_name === 'EIHO');
    expect(eiho.etc_chip).toBe('No ETC');
    expect(eiho.flags).toContain('NOR not accepted');
  });

  it('counts the phase cards and the voyage tiles, Sailed once per plan within 72 h', async () => {
    const d = await run();
    expect(d.at_berth.cards.loading).toEqual({ total: 1, pre: 0, ops: 1, post: 0 });
    expect(d.at_berth.cards.unloading).toEqual({ total: 1, pre: 1, ops: 0, post: 0 });
    expect(d.at_berth.tiles.at_berth).toBe(2);
    expect(d.at_berth.tiles.sailed_last_72h).toBe(2);
    expect(d.at_berth.phase_basis).toMatch(/status/);
  });

  it('sorts by time alongside, longest first', async () => {
    const d = await run();
    const hours = d.at_berth.vessels.map((v: any) => v.alongside_hours);
    expect([...hours].sort((a, b) => b - a)).toEqual(hours);
  });
});

describe('waiting to berth and arriving', () => {
  it('waiting: arrived, not alongside, not sailed, not rejected', async () => {
    const d = await run();
    expect(d.waiting_to_berth.vessels.map((v: any) => v.vessel_name)).toEqual(['BG WAITING ONE']);
    const w = d.waiting_to_berth.vessels[0];
    expect(w.waiting_days).toBeCloseTo(10, 0);
    expect(w.vessel_capacity).toBe(2500);
    expect(w.si_qty_mt).toBe(2400);
    expect(w.commodity).toBe('COAL');
  });

  it('arriving (3 days): overdue first, then by ETA, ETB fallback, far and rejected left out', async () => {
    const d = await run();
    expect(d.arriving.vessels.map((v: any) => v.vessel_name)).toEqual(['MT OVERDUE ETA', 'MT ARRIVING SOON', 'BG NO ETA']);
    expect(d.arriving.vessels[0].overdue).toBe(true);
    expect(d.arriving.vessels[0].due).toBe('overdue');
    expect(d.arriving.overdue).toBe(1);
  });

  it('under the cap, stale overdue plans never crowd out the vessels due in the window', async () => {
    state.staleOverduePlans = 60;
    try {
      const d = await run();
      const names = d.arriving.vessels.map((v: any) => v.vessel_name);
      expect(names).toHaveLength(40);
      expect(names).toEqual(expect.arrayContaining(['MT OVERDUE ETA', 'MT ARRIVING SOON', 'BG NO ETA']));
      expect(names).not.toContain('MT STALE 59'); // the most overdue goes first
      expect(d.arriving.count).toBe(63);
      expect(d.arriving.overdue).toBe(61);
      expect(d.arriving.overdue_left_out).toBe(23);
    } finally {
      state.staleOverduePlans = 0;
    }
  });

  it('a wider window takes in later arrivals', async () => {
    const d = await run({ arrivals_window_days: 14 });
    expect(d.arriving.vessels.map((v: any) => v.vessel_name)).toContain('MV FAR AWAY');
  });

  it('asks JPS for the plans with no date window, and sends nothing but GETs', async () => {
    await run();
    const plans = state.requests.filter((r) => r.path === '/api/v1/shipment-plans');
    expect(plans).toHaveLength(1);
    for (const r of state.requests) if (r.method !== 'GET') expect(r.path).toBe('/api/v1/auth/login');
  });
});

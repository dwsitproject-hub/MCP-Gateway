/**
 * jetty_tank_farm, and mostly the units.
 *
 * JPS labels exactly one column: observedDensityKgM3. totalObservedVolume and
 * totalMass are unlabelled, and reading mass as kilograms when it is tonnes is a
 * 1000x error in an answer that looks entirely reasonable - the same trap as KLIP's
 * quantities, which sat behind a `unit` field reading "MT" while holding kilograms.
 *
 * So the tool derives the units from the rows it fetched: mass = volume x density is
 * true by definition, and the RATIO identifies what the columns are in. These tests
 * pin all three outcomes, including the one that matters most - figures that match
 * neither reading must be reported as UNKNOWN rather than rounded into whichever is
 * closer.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockJetty, freshJettyState, type MockJettyState } from './fixtures/mockJetty.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.jettyTankFarm;
let server: Server;
let state: MockJettyState;

type Mods = {
  tool: (typeof import('../src/tools/jetty/tankFarm.js'))['jettyTankFarm'];
  resetJettySession: (typeof import('../src/adapters/jetty/session.js'))['resetJettySession'];
};
let m: Mods;

const ctx = { requestId: 'test-request', userId: 'tester@example.com' };

beforeAll(async () => {
  process.env.JETTY_BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;
  process.env.JETTY_SVC_USER = 'MCP';
  process.env.JETTY_SVC_PASS = 'a-long-enough-password';
  process.env.JETTY_PORT_ID = '1';
  process.env.JETTY_ENV = 'production';

  state = freshJettyState();
  await new Promise<void>((resolve) => {
    server = createMockJetty(state).listen(PORT, '127.0.0.1', resolve);
  });

  const toolMod = await import('../src/tools/jetty/tankFarm.js');
  const session = await import('../src/adapters/jetty/session.js');
  m = { tool: toolMod.jettyTankFarm, resetJettySession: session.resetJettySession };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.requests.length = 0;
  state.tankMassUnit = 'kg';
  m.resetJettySession();
});

async function run(args: Record<string, unknown> = {}) {
  const { z } = await import('zod');
  const parsed = z.strictObject(m.tool.inputShape).parse(args);
  return m.tool.handler(parsed as never, ctx);
}

describe('working out the units instead of assuming them', () => {
  it('reports KILOGRAMS when volume x density equals mass', async () => {
    const d = (await run()).data as Record<string, any>;
    expect(String(d.units_note)).toMatch(/KILOGRAMS/);
    expect(String(d.units_note)).toMatch(/CUBIC METRES/);
    // The evidence travels with the claim, not just the conclusion.
    expect(String(d.units_note)).toMatch(/measured on 3 tank\(s\)/);
  });

  it('reports METRIC TONNES when mass is a thousandth of that', async () => {
    state.tankMassUnit = 'tonne';
    const d = (await run()).data as Record<string, any>;
    expect(String(d.units_note)).toMatch(/METRIC TONNES/);
    expect(String(d.units_note)).toMatch(/Do not divide again/);
  });

  it('reports UNKNOWN rather than picking the nearer of two wrong answers', async () => {
    // The case that matters. A ratio of 37 is neither 1 nor 1000, and a tool that
    // rounded to whichever is closer would publish a confident 1000x error.
    state.tankMassUnit = 'broken';
    const d = (await run()).data as Record<string, any>;
    expect(String(d.units_note)).toMatch(/UNKNOWN/);
    expect(String(d.units_note)).toMatch(/do not convert/);
    expect(String(d.units_note)).not.toMatch(/KILOGRAMS|METRIC TONNES/);
  });
});

describe('totals', () => {
  it('sums only the tanks that HAVE a reading, and counts the ones it left out', async () => {
    // T-04 has no mass. Dropping it silently would be indistinguishable from a smaller
    // stock, which is the one reading a tank-farm figure must never support.
    const d = (await run()).data as Record<string, any>;
    expect(d.totals.tanks_included_in_mass).toBe(3);
    expect(d.totals.tanks_excluded_from_mass).toBe(1);
    expect(d.totals.mass).toBe(1000 * 900 + 2000 * 900 + 500 * 920);
  });

  it('breaks the total down by product, heaviest first', async () => {
    const d = (await run()).data as Record<string, any>;
    expect(d.by_product[0].product).toBe('CPO');
    expect(d.by_product[0].mass).toBe(1000 * 900 + 2000 * 900);
    // The out-of-service CPO tank still COUNTS as a CPO tank; it just adds no mass.
    expect(d.by_product[0].tanks).toBe(3);
  });

  it('says the totals were computed here rather than supplied by JPS', async () => {
    const d = (await run()).data as Record<string, any>;
    expect(String(d.computed_here)).toMatch(/SUMS taken here/);
  });
});

describe('filtering and provenance', () => {
  it('narrows by product', async () => {
    const d = (await run({ product: 'pko' })).data as Record<string, any>;
    expect(d.tanks).toHaveLength(1);
    expect(d.tanks[0].tank_code).toBe('T-03');
    expect(d.tanks_at_this_port).toBe(4);
  });

  it('distinguishes "no tank matched" from "the farm is empty"', async () => {
    const d = (await run({ product: 'NO SUCH PRODUCT' })).data as Record<string, any>;
    expect(String(d.empty_result_note)).toMatch(/No tank matched the filter/);
    expect(String(d.empty_result_note)).toMatch(/4 exist at this port/);
  });

  it('sends the port as a QUERY parameter, which this route alone requires', async () => {
    await run();
    const call = state.requests.find((r) => r.path === '/api/v1/tank-gauging/latest');
    expect(call).toBeDefined();
    // Without it JPS answers 400 "portId is required" - the mock enforces that, so a
    // regression here fails as a tool error rather than as an empty tank farm.
    expect(call?.method).toBe('GET');
  });

  it('claims no units on the envelope, because JPS does not label these columns', async () => {
    const out = await run();
    expect(out.units).toBeNull();
    expect(out.system).toBe('jetty');
  });
});

/**
 * jetty_at_berth against a mock JPS, through the real client, session and envelope.
 *
 * The login path is exercised end to end on purpose. Writing this test found a real
 * bug by inspection first: the session read the credential from `res.headers`, but
 * JettyResponse never carried headers - so the JPS cookie could never be found and
 * every login would have failed with "no bearer token found", which is a confusing way
 * to say "the client dropped the header". A mock that returned a body token would have
 * passed while production stayed broken.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockJetty, freshJettyState, type MockJettyState } from './fixtures/mockJetty.js';
import { PORTS } from './fixtures/ports.js';

// Allocated in the registry, not picked here. 5193 was hardcoded first and is
// hubTokenAuth's - the collision would have surfaced as nine Hub failures rather than
// as a failure in this file, which is the whole reason the registry exists.
const PORT = PORTS.jettyAtBerth;
let server: Server;
let state: MockJettyState;

type Mods = {
  tool: typeof import('../src/tools/jetty/atBerth.js')['jettyAtBerth'];
  wrap: typeof import('../src/mcp/envelope.js')['wrap'];
  resetJettySession: typeof import('../src/adapters/jetty/session.js')['resetJettySession'];
};
let m: Mods;

const ctx = { requestId: 'test-request', userId: 'tester@example.com' };

beforeAll(async () => {
  process.env.JETTY_BASE_URL = `http://127.0.0.1:${PORT}/api/v1`;
  process.env.JETTY_SVC_USER = 'MCP';
  process.env.JETTY_SVC_PASS = 'a-long-enough-password';
  process.env.JETTY_PORT_ID = '1';
  process.env.JETTY_ENV = 'staging';

  state = freshJettyState();
  await new Promise<void>((resolve) => {
    server = createMockJetty(state).listen(PORT, '127.0.0.1', resolve);
  });

  const toolMod = await import('../src/tools/jetty/atBerth.js');
  const env = await import('../src/mcp/envelope.js');
  const session = await import('../src/adapters/jetty/session.js');
  m = { tool: toolMod.jettyAtBerth, wrap: env.wrap, resetJettySession: session.resetJettySession };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.requests.length = 0;
  state.staleSources = 0;
  state.cargoShape = 'object';
  state.gaugeConnected = true;
  m.resetJettySession();
});

async function run(args: Record<string, unknown> = {}) {
  const { z } = await import('zod');
  const parsed = z.strictObject(m.tool.inputShape).parse(args);
  return m.tool.handler(parsed as never, ctx);
}

describe('reading the berths', () => {
  it('logs in with the cookie credential and reports both vessels', async () => {
    const out = await run();
    const d = out.data as Record<string, any>;

    expect(d.vessels_alongside).toBe(2);
    expect(d.vessels[0].vessel_name).toBe('MT. GIAT ARMADA 02');
    expect(d.vessels[0].cargo_moved).toBe(1470);
    expect(d.vessels[0].cargo_total).toBe(3500);

    // The login actually happened, and every read carried a Bearer built from the
    // jps_at cookie - the bug this test was written to catch.
    const login = state.requests.find((r) => r.path === '/api/v1/auth/login');
    expect(login?.method).toBe('POST');
    const reads = state.requests.filter((r) => r.method === 'GET');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.auth).toMatch(/^Bearer /);
  });

  it('sends the port scope on every read', async () => {
    await run();
    for (const r of state.requests.filter((x) => x.method === 'GET')) {
      expect(r.portHeader).toBe('1');
    }
  });

  it('never sends anything but GET and the single login POST', async () => {
    await run();
    for (const r of state.requests) {
      if (r.method === 'POST') expect(r.path).toBe('/api/v1/auth/login');
      else expect(r.method).toBe('GET');
    }
  });

  it('keeps an unrecorded milestone null rather than zeroing it', async () => {
    const out = await run();
    const eiho = (out.data as any).vessels.find((v: any) => v.vessel_name === 'EIHO');
    // EIHO has no NOR and no ETC in JPS. Null means unrecorded; 0 or a date would be an
    // invention, and this is the distinction the whole connector rests on.
    expect(eiho.nor_accepted_at).toBeNull();
    expect(eiho.estimated_completion).toBeNull();
    expect(eiho.operations_completed_at).toBeNull();
    // It is alongside via dockingStartTime rather than tbAt, and still gets an elapsed.
    expect(eiho.alongside_hours).toBeGreaterThan(1.5);
  });

  it('reports no cargo figures for a vessel the ATG summary does not cover', async () => {
    const out = await run();
    const eiho = (out.data as any).vessels.find((v: any) => v.vessel_name === 'EIHO');
    expect(eiho.cargo_moved).toBeNull();
  });
});

describe('the cargo trust signal', () => {
  it('says the figures are current when every ATG source is fresh', async () => {
    const out = await run();
    const d = out.data as Record<string, any>;
    expect(d.atg_sync.all_healthy).toBe(true);
    expect(String(d.cargo_trust_note)).toMatch(/synced within the last hour/);
  });

  it('warns, with the count, when a source has gone stale', async () => {
    /**
     * A stale ATG source means cargo_moved stopped advancing while the vessel kept
     * loading. The number still looks perfectly reasonable, which is exactly why the
     * caveat has to travel with it rather than sit in a field nobody reads.
     */
    state.staleSources = 2;
    const out = await run();
    const d = out.data as Record<string, any>;
    expect(d.atg_sync.stale_sources).toBe(2);
    expect(String(d.cargo_trust_note)).toMatch(/^2 ATG source\(s\) have not synced/);
    expect(String(d.cargo_trust_note)).toMatch(/stopped advancing while loading continued/);
  });
});

describe('the two cargo-progress shapes', () => {
  it('reads the PRODUCTION shape: an object keyed by operation id', async () => {
    /**
     * The bug this pins. Production returns { summaries: { "901": {...}, "902": null } }
     * where staging returned an array, and `for...of` over an object throws "not
     * iterable" - so the tool did not degrade to null cargo, it failed outright. The
     * total is spelled siQty here and totalQty on staging.
     */
    const out = await run();
    const v = (out.data as any).vessels.find((x: any) => x.vessel_name === 'MT. GIAT ARMADA 02');
    expect(v.cargo_moved).toBe(1470);
    expect(v.cargo_total).toBe(3500);
    expect(v.cargo_unit).toBe('MT');
    expect(v.gauge_connected).toBe(true);
  });

  it('still reads the STAGING shape, an array of rows', async () => {
    // Kept working on purpose: the two environments disagree, and a connector that
    // only parses whichever one it saw last is the thing being fixed here.
    state.cargoShape = 'array';
    const out = await run();
    const v = (out.data as any).vessels.find((x: any) => x.vessel_name === 'MT. GIAT ARMADA 02');
    expect(v.cargo_moved).toBe(1470);
    expect(v.cargo_total).toBe(3500);
  });

  it('reports no reading, rather than zero, where JPS sends null', async () => {
    const out = await run();
    const eiho = (out.data as any).vessels.find((x: any) => x.vessel_name === 'EIHO');
    expect(eiho.cargo_moved).toBeNull();
    expect(eiho.cargo_total).toBeNull();
    expect((out.data as any).vessels_without_a_cargo_reading).toContain('EIHO');
  });

  it('warns per vessel when ITS gauge is disconnected, even with the port healthy', async () => {
    /**
     * atg-sync-health is the PORT's state. A single operation can be disconnected while
     * the port reads healthy, and then that one vessel's tonnage is frozen while every
     * other figure on the page is live - the most misleading arrangement available.
     */
    state.gaugeConnected = false;
    const out = await run();
    const d = out.data as Record<string, any>;
    expect(d.atg_sync.all_healthy).toBe(true);
    expect(d.vessels_with_a_disconnected_gauge).toContain('MT. GIAT ARMADA 02');
    expect(String(d.cargo_trust_note)).toMatch(/DISCONNECTED gauge/);
    expect(String(d.cargo_trust_note)).toMatch(/not advancing/);
  });
});

describe('provenance', () => {
  it('says the data came from JPS, not from KLIP', async () => {
    /**
     * With two upstreams behind one connector, the envelope is the only thing telling a
     * reader which system produced the number in front of them. A Jetty result carrying
     * "Data from KLIP" would be a false provenance claim.
     */
    const out = await run();
    const envelope = m.wrap({ tool: 'jetty_at_berth', ...out }, out.data);
    expect(envelope._integrity).toMatch(/Jetty Planning System/);
    expect(envelope._integrity).not.toMatch(/KLIP/);
    expect(envelope.source).toMatch(/^JPS staging/);
    expect(envelope.environment).toBe('staging');
  });

  it('claims no units, because JPS carries a metric code per row', async () => {
    const out = await run();
    expect(out.units).toBeNull();
    const first = (out.data as any).vessels[0];
    expect(first.si_quantity_unit).toBe('MT');
  });
});

describe('filtering', () => {
  it('narrows by vessel and explains an empty result honestly', async () => {
    const hit = await run({ vessel_name: 'eiho' });
    expect((hit.data as any).vessels).toHaveLength(1);

    const miss = await run({ vessel_name: 'NO SUCH SHIP' });
    const d = miss.data as Record<string, any>;
    expect(d.vessels).toHaveLength(0);
    // Distinguishes "nothing matched your filter" from "no vessels are alongside" -
    // reporting the second when the first is true would be a claim about the port.
    expect(String(d.empty_result_note)).toMatch(/No vessel matched the filter/);
    expect(String(d.empty_result_note)).toMatch(/2 are alongside/);
  });
});

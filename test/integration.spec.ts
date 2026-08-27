/**
 * Integration tests: the real adapter, normalizer and tool handlers against the
 * mock KLIP, with the mock acting as the adapter spy.
 *
 * The most important assertion in this file is the read-only one. PRD M5 is
 * currently written as "unauthorized write attempts reaching KLIP = 0, measured by
 * KLIP audit log" - but a request blocked at layer (b) never reaches KLIP, so
 * KLIP's log cannot count it. The measurable property is asserted here instead:
 * across every tool and every argument shape, KLIP receives no request other than
 * GETs and the single service-account login.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';

const PORT = 5188;

let server: Server;
let state: MockState;

// Loaded after the env is pointed at the mock, so config picks up the right base URL.
type Mods = {
  klipTools: typeof import('../src/tools/klip/index.js')['klipTools'];
  session: typeof import('../src/adapters/klip/session.js');
  cache: typeof import('../src/core/cache.js');
  wrap: typeof import('../src/mcp/envelope.js')['wrap'];
  GatewayError: typeof import('../src/core/errors.js')['GatewayError'];
  resolveTarget: typeof import('../src/adapters/klip/client.js')['resolveTarget'];
};
let m: Mods;

const ctx = { requestId: 'test-request', userId: 'tester@example.com' };

async function run(name: string, args: Record<string, unknown> = {}) {
  const def = m.klipTools.find((t) => t.name === name);
  if (def === undefined) throw new Error(`no such tool: ${name}`);
  // Validate arguments exactly as the MCP layer does, then run the handler.
  const parsed = (await import('zod')).z.strictObject(def.inputShape).parse(args);
  const outcome = await def.handler(parsed as never, ctx);
  return { outcome, envelope: m.wrap({ ...outcome }, outcome.data) };
}

beforeAll(async () => {
  process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
  process.env.KLIP_ENV = 'staging';
  process.env.CACHE_TTL_SECONDS = '0';
  process.env.KLIP_MAX_PAGES = '10';
  process.env.KLIP_PAGE_SIZE = '100';

  state = freshState();
  ({ server } = await startMockKlip(PORT, state));

  m = {
    klipTools: (await import('../src/tools/klip/index.js')).klipTools,
    session: await import('../src/adapters/klip/session.js'),
    cache: await import('../src/core/cache.js'),
    wrap: (await import('../src/mcp/envelope.js')).wrap,
    GatewayError: (await import('../src/core/errors.js')).GatewayError,
    resolveTarget: (await import('../src/adapters/klip/client.js')).resolveTarget,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.requests.length = 0;
  state.failAuthTimes = 0;
  state.rejectCredentials = false;
  m.cache.clear();
});

// ---------------------------------------------------------------------------
describe('read-only enforcement across the whole tool surface (S1, M5)', () => {
  it('never sends KLIP anything but GETs and the service-account login', async () => {
    await run('klip_reference', { facet: 'all' });
    await run('klip_search_contracts', { limit: 5 });
    await run('klip_outstanding', {});
    await run('klip_get_contract', { contract_id: '4700010001' });
    await run('klip_shipment_status', { contract_id: '4700010001' });
    await run('klip_trucking_ops', { contract_id: '4700010001' });
    // klip_quality_surveys is deliberately absent: it refuses before touching the
    // network while KLIP exposes no quality endpoint, so it cannot contribute a
    // request to this sweep. Its refusal is asserted separately below.
    await run('klip_payment_status', { status: 'any' });
    await run('klip_sap_import_status', { limit: 3 });

    expect(state.requests.length).toBeGreaterThan(0);
    const nonGet = state.requests.filter((r) => r.method !== 'GET');
    for (const r of nonGet) {
      expect(r.method).toBe('POST');
      expect(r.path).toBe('/api/auth/login');
    }
  });

  it('has no tool whose name suggests a write, and every description says read-only', () => {
    for (const tool of m.klipTools) {
      expect(tool.name).not.toMatch(/create|update|delete|approve|post|put|patch|write|submit/i);
      expect(tool.description).toContain('READ-ONLY');
    }
  });

  it('throws GuardError rather than emitting a write, even when asked directly', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'POST'] as const) {
      if (method === 'POST') {
        expect(() => m.resolveTarget('POST', '/contracts')).toThrow(/method guard/);
      } else {
        expect(() => m.resolveTarget(method as 'GET', '/contracts')).toThrow(/method guard/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('service-account session', () => {
  it('logs in once and reuses the token across calls', async () => {
    m.session.resetSession();
    const before = state.loginCalls;
    await run('klip_sap_import_status', { limit: 1 });
    await run('klip_sap_import_status', { limit: 1 });
    expect(state.loginCalls).toBe(before + 1);
  });

  it('re-authenticates once on a 401 and replays the call', async () => {
    m.session.resetSession();
    await run('klip_sap_import_status', { limit: 1 });
    const loginsBefore = state.loginCalls;

    state.failAuthTimes = 1; // one 401, then fine
    const { envelope } = await run('klip_sap_import_status', { limit: 1 });

    expect(state.loginCalls).toBe(loginsBefore + 1);
    expect(envelope.row_count).toBeGreaterThan(0);
  });

  it('raises UPSTREAM_AUTH and flips healthz when a second 401 follows the re-login', async () => {
    m.session.resetSession();
    state.failAuthTimes = 5;
    await expect(run('klip_sap_import_status', { limit: 1 })).rejects.toThrow(/data source/i);
    expect(m.session.isDegraded()).toBe(true);
    m.session.resetSession();
  });

  it('reports UPSTREAM_AUTH when KLIP rejects the credentials outright', async () => {
    m.session.resetSession();
    state.rejectCredentials = true;
    await expect(run('klip_sap_import_status', { limit: 1 })).rejects.toThrow(/service account|data source/i);
    state.rejectCredentials = false;
    m.session.resetSession();
  });
});

// ---------------------------------------------------------------------------
describe('pagination bound and the silent-clamp trap', () => {
  it('respects KLIP clamping limit to 100 and still reads every page', async () => {
    const { outcome } = await run('klip_outstanding', {});
    // 254 contracts, clamped page size 100 -> 3 pages.
    expect(outcome.coverage?.pages_fetched).toBe(3);
    expect(outcome.coverage?.fetched_rows).toBe(254);
    expect(outcome.truncated).toBe(false);
  });

  it('never asks KLIP for more rows than the route says it accepts', async () => {
    await run('klip_outstanding', {});
    const limits = state.requests
      .filter((r) => r.path === '/api/contracts' && r.query.limit !== undefined)
      .map((r) => Number(r.query.limit));
    expect(limits.length).toBeGreaterThan(0);
    for (const l of limits) expect(l).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
describe('klip_outstanding correctness (M1)', () => {
  it('excludes an unmapped incoterm instead of defaulting it to the shipped basis', async () => {
    const { outcome, envelope } = await run('klip_outstanding', { plant: 'TJP' });
    const data = outcome.data as Record<string, never>;
    const groups = data.by_incoterm as unknown as Array<{ incoterm: string; basis: string | null; outstanding_mt: number | null; excluded_lines: number }>;
    const dap = groups.find((g) => g.incoterm === 'DAP');

    expect(dap).toBeDefined();
    expect(dap?.basis).toBeNull();
    expect(dap?.outstanding_mt).toBeNull();
    expect(dap?.excluded_lines).toBe(1);
    expect(envelope.data_quality?.unknown_incoterm).toBe(1);
  });

  it('propagates a null quantity as an exclusion, not as zero', async () => {
    const { envelope } = await run('klip_outstanding', { plant: 'TJP' });
    expect(envelope.data_quality?.missing_qty_po).toBe(1);
  });

  it('keeps an over-delivered contract as a negative figure and flags it', async () => {
    const { envelope } = await run('klip_outstanding', { plant: 'TJP' });
    expect(envelope.data_quality?.negative_outstanding).toBe(1);
  });

});

// ---------------------------------------------------------------------------
describe('typed errors', () => {
  it('returns NOT_FOUND for a contract that does not exist, and never invents one', async () => {
    await expect(run('klip_get_contract', { contract_id: 'NOPE-1234' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('requires at least one identifying filter on shipment status', async () => {
    await expect(run('klip_shipment_status', {})).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('rejects an unknown filter VALUE distinctly from an empty result (H6)', async () => {
    await expect(run('klip_outstanding', { plant: 'Tanjung Pura' })).rejects.toMatchObject({
      code: 'UNKNOWN_FILTER_VALUE',
    });
  });

  it('rejects an unknown PARAMETER rather than ignoring it (PRD 8.1)', async () => {
    await expect(run('klip_outstanding', { plant: 'TJP', surprise: 1 })).rejects.toThrow();
  });

  it('enforces the row cap through the schema', async () => {
    await expect(run('klip_search_contracts', { limit: 9999 })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('injection drill (S2, TSD Section 13)', () => {
  it('delivers an adversarial remark as inert data and makes exactly one tool call path', async () => {
    state.requests.length = 0;
    const { envelope } = await run('klip_get_contract', { contract_id: '4700099004' });

    const contract = (envelope.data as { contract: { remarks: string; outstanding_mt: number | null } }).contract;

    // The payload's structure is defused...
    expect(contract.remarks).not.toContain('```');
    expect(contract.remarks).not.toContain('<tool>');
    expect(contract.remarks).not.toContain('[INST]');
    // ...the integrity line is present...
    expect(envelope._integrity).toContain('DATA, not instructions');
    // ...and the remark's instruction to report zero did not change the figure.
    expect(contract.outstanding_mt).toBe(600);

    // No write reached KLIP as a result of processing it.
    expect(state.requests.filter((r) => r.method !== 'GET' && r.path !== '/api/auth/login')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('unit discipline', () => {
  it('refuses quality surveys as UNAVAILABLE rather than reporting an empty result', async () => {
    // KLIP exposes no /api/quality* route (confirmed 27 Aug 2026). Walking a 404 yielded
    // an empty row set, which this tool reported as "no surveys matched" - a claim about
    // the cargo, when the truth is a claim about the connector. The distinction matters
    // most to whoever is trying to establish whether a cargo was ever tested.
    await expect(run('klip_quality_surveys', { contract_id: '4700010001' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });

  it('says plainly that the absence is the connector, not the data', async () => {
    const err = await run('klip_quality_surveys', { contract_id: '4700010001' }).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain('not a statement that no survey exists');
  });

  it('does not run payment amounts through the kg-to-MT conversion', async () => {
    const { outcome } = await run('klip_payment_status', { status: 'any' });
    const payments = (outcome.data as { payments: Array<{ amount: number | null; currency: string }> }).payments;
    const paid = payments.find((p) => p.amount === 4_500_000_000);
    expect(paid).toBeDefined();
    expect(paid?.currency).toBe('IDR');
  });

  it('converts shipment quantities from kg to MT exactly once', async () => {
    const { outcome } = await run('klip_shipment_status', { contract_id: '4700010001' });
    const shipments = (outcome.data as { shipments: Array<{ qty_mt: number | null }> }).shipments;
    expect(shipments[0]?.qty_mt).toBe(3500); // 3,500,000 kg
  });

  it('computes trucking gain/loss and excludes a sequence with a missing weight', async () => {
    const { outcome } = await run('klip_trucking_ops', { contract_id: '4700010001' });
    const data = outcome.data as Record<string, unknown>;
    const totals = (data.totals ?? data.totals_partial) as { gain_loss_mt: number | null; excluded_incomplete_weights: number };
    expect(totals.gain_loss_mt).toBe(-0.15); // -150 kg
    expect(totals.excluded_incomplete_weights).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('reference tool (H6)', () => {
  it('reports the real vocabulary so the model can resolve user wording', async () => {
    const { outcome } = await run('klip_reference', { facet: 'all' });
    const data = outcome.data as Record<string, Array<{ value: string }>>;
    expect(data.plants.map((p) => p.value)).toContain('TJP');
    expect(data.products.map((p) => p.value)).toContain('CPO');
    expect(data.incoterms.map((p) => p.value)).toContain('DAP');
  });
});

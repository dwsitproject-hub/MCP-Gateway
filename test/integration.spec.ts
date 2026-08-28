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
    // The mock clamps page size to 100 however many rows exist, so the property under
    // test is that EVERY page is read - not that the fixture holds a specific count.
    const all = state.contracts.length;
    expect(outcome.coverage?.pages_fetched).toBe(Math.ceil(all / 100));
    expect(outcome.coverage?.fetched_rows).toBe(all);
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
    /**
     * M1 still stands; only where it is observable has moved.
     *
     * This used to read the per-incoterm breakdown, which is gone: it was our tally over
     * the rows read, and a figure that cannot reconcile with KLIP's total is a second
     * answer to the same question. The property itself - an unrecognised incoterm is
     * flagged and excluded, never silently pushed onto the shipped basis - is still
     * reported, through data_quality and the cross-check exclusion count.
     */
    const { outcome, envelope } = await run('klip_outstanding', { plant: 'TJP' });
    const data = outcome.data as Record<string, unknown>;

    // Flagged by name in data_quality, which is where a row-level concern belongs.
    expect(envelope.data_quality?.unknown_incoterm).toBe(1);

    /**
     * Everything about the connector's OWN cross-check is now logged rather than
     * published, so this no longer asserts on it.
     *
     * That is deliberate. Publishing our exclusion count alongside KLIP's total invited
     * the answer to discuss the connector instead of the contracts - the same pull that
     * made a live chat splice two systems' figures into a third number. The property
     * under test is that an unrecognised incoterm is FLAGGED and not silently defaulted
     * onto the shipped basis; data_quality carries that, and nothing else needs to.
     */
    expect(data.by_incoterm).toBeUndefined();
    expect(data.excluded_from_cross_check).toBeUndefined();
    expect(data.reconciliation_note).toBeUndefined();
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

  it('rejects a shipment status KLIP would silently ignore', async () => {
    // KLIP returns EVERY row for status=BOGUS rather than 400, so an unchecked string
    // would answer a filtered question with the unfiltered table. The enum has to be
    // enforced on this side, and this is the test that it is.
    //
    // The rejection is a ZodError, not a GatewayError: schema validation happens before
    // the handler runs, in the MCP layer, and this harness parses the same way.
    await expect(run('klip_shipment_status', { status: 'BOGUS' })).rejects.toThrow(/Invalid option/);
  });

  it('applies vessel_name locally, because KLIP accepts it and ignores it', async () => {
    // The regression that started this: vesselName was declared as an upstream param, so
    // buildFilters believed KLIP had applied it and skipped the local pass. KLIP had not,
    // and the tool returned the whole table as that vessel's shipments.
    const { outcome } = await run('klip_shipment_status', { vessel_name: 'EIHO' });
    const data = outcome.data as {
      shipments: Array<{ vessel_name: string | null }>;
      summary_scope: string;
    };
    expect(data.shipments).toHaveLength(1);
    expect(data.shipments[0]?.vessel_name).toBe('EIHO');
    // And the caller is told the KLIP summary is WIDER than the rows, because it is.
    expect(data.summary_scope).toMatch(/WIDER/);
  });

  it('reports the KLIP status summary rather than recounting rows', async () => {
    const { outcome } = await run('klip_shipment_status', { plant: 'Bontang' });
    const data = outcome.data as {
      klip_status_summary: { planned: number; at_discharge_port: number; completed: number };
      klip_summary_reconciliation?: string;
      summary_scope: string;
    };
    expect(data.klip_status_summary.planned).toBe(1);
    expect(data.klip_status_summary.at_discharge_port).toBe(1);
    expect(data.klip_status_summary.completed).toBe(1);
    // KLIP's parts do not sum to KLIP's own total. That is surfaced, not smoothed.
    expect(data.klip_summary_reconciliation).toMatch(/sum to 5 against its own total of 3/);
    expect(data.summary_scope).toMatch(/covers exactly this query/);
  });

  it('ages open shipments against the delivery window KLIP publishes', async () => {
    // The user's actual question - past the due delivery end with no estimate and no
    // actual - which a live chat answered with "no delivery-end-date field exists".
    const { outcome } = await run('klip_shipment_status', { plant: 'Bontang', open_only: true });
    const data = outcome.data as {
      delivery_window_ageing: {
        open_shipments_considered: number;
        past_delivery_end_7_days_or_more: number;
        of_those_no_estimate_and_no_actual: number;
      };
      shipments: Array<{ delivery_end_date: string | null; days_past_delivery_end: number | null }>;
    };
    // SHP-1 (ARRIVED_DP) and SHP-2 (PLANNED) are open; SHP-3 is COMPLETED.
    expect(data.delivery_window_ageing.open_shipments_considered).toBe(2);
    expect(data.delivery_window_ageing.past_delivery_end_7_days_or_more).toBe(2);
    // Only SHP-2 has neither an estimate nor an actual anywhere.
    expect(data.delivery_window_ageing.of_those_no_estimate_and_no_actual).toBe(1);
    // Most overdue first, so the answer survives the row cap.
    expect(data.shipments[0]?.delivery_end_date).toBe('2026-01-10');
  });

  it('names milestones by rung, so arrival before sailing is not a swapped column', async () => {
    // A live chat reported "ETD and ETA are swapped, seven for seven" as a KLIP defect.
    // It was this connector labelling arrival-at-the-loading-port as the voyage ETA.
    const { outcome } = await run('klip_shipment_status', { contract_id: '4700010001' });
    const s = (
      outcome.data as {
        shipments: Array<{
          eta_loading_arrival: string | null;
          eta_sailed_from_loading: string | null;
          ata_loading_arrival: string | null;
        }>;
      }
    ).shipments[0];
    expect(s?.eta_loading_arrival).toBe('2026-07-02');
    expect(s?.eta_sailed_from_loading).toBe('2026-07-06');
    // The real actuals live in ata_vessel_*, which the old map never read.
    expect(s?.ata_loading_arrival).toBe('2026-07-04');
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
    const shipments = (outcome.data as { shipments: Array<{ shipped_qty_mt: number | null }> }).shipments;
    expect(shipments[0]?.shipped_qty_mt).toBe(3500); // 3,500,000 kg
  });

  it('computes trucking gain/loss from dispatched versus received, in KLIP terms', async () => {
    const { outcome } = await run('klip_trucking_ops', { contract_id: '4700010001' });
    const data = outcome.data as Record<string, unknown>;
    const totals = (data.totals ?? data.totals_partial) as {
      dispatched_mt: number | null;
      received_mt: number | null;
      gain_loss_mt: number | null;
      excluded_incomplete_weights: number;
    };
    // 30,000 kg dispatched, 29,850 received: a 150 kg loss in transit.
    expect(totals.gain_loss_mt).toBe(-0.15);
    expect(totals.excluded_incomplete_weights).toBe(1);
  });

  it('does not report a sent weight, because KLIP has none on this endpoint', async () => {
    // quantity_sent is empty in every production row. KLIP proposed mapping the
    // dispatched figure onto qty_sent_mt; a mislabelled number is worse than a null,
    // because a null is visibly missing and a wrong label is not.
    const { outcome } = await run('klip_trucking_ops', { contract_id: '4700010001' });
    const json = JSON.stringify(outcome.data);
    expect(json).not.toContain('qty_sent_mt');
    expect(json).toContain('dispatched_mt');
    expect(json).toContain('received_mt');
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

// ---------------------------------------------------------------------------
describe('the incoterm filter goes upstream (KLIP 27 Aug)', () => {
  it('sends incoterms to KLIP rather than filtering after the fetch', async () => {
    await run('klip_outstanding', { plant: 'TJP', incoterm: 'FOB' });
    const call = state.requests.filter((r) => r.path === '/api/contracts').pop();
    expect(call?.query.incoterms).toBe('FOB');
  });

  it('narrows the fetch, so coverage describes the population asked about', async () => {
    // Filtered locally, coverage reported every contract for the plant - a figure about a
    // population the caller never asked for. Pushing it upstream makes coverage honest
    // and stops fetching rows only to discard them.
    const all = await run('klip_outstanding', { plant: 'TJP' });
    const fob = await run('klip_outstanding', { plant: 'TJP', incoterm: 'FOB' });
    expect(fob.outcome.coverage?.total_rows).toBeLessThan(all.outcome.coverage?.total_rows ?? 0);
  });

  it('returns only the requested incoterm', async () => {
    const { outcome } = await run('klip_outstanding', { plant: 'TJP', incoterm: 'FOB' });
    const rows = (outcome.data as { top_contracts: Array<{ incoterm: string | null }> }).top_contracts;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.incoterm).toBe('FOB');
  });

  it('returns nothing for an incoterm no contract uses, rather than everything', async () => {
    // The failure mode this guards: an unrecognised filter accepted and discarded, so a
    // narrow question comes back with the whole population and reads as the answer.
    const { outcome } = await run('klip_outstanding', { plant: 'TJP', incoterm: 'NOPE' });
    const rows = (outcome.data as { top_contracts: unknown[] }).top_contracts;
    expect(rows).toHaveLength(0);
  });
});

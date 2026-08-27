/**
 * klip_reference sources its vocabularies from KLIP's canonical filter-option endpoints
 * where they exist, and says so where they do not.
 *
 * The reason this matters is measurable. A 1,000-row contract sample produced exactly
 * three incoterms - FOB, FRC, LCO. The canonical list has SIX: Blank, CFR, CIF, FOB,
 * FRC, LCO. Reporting the sample as "the values that exist in KLIP" understated the
 * domain by half, and a user asking about a CIF contract would have been told no such
 * incoterm exists.
 *
 * Two of those six have no outstanding basis in this connector, which silently excludes
 * those contracts from every outstanding total. Surfacing that is the point.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshState, startMockKlip, type MockState } from './fixtures/mockKlip.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.vocabulary;

process.env.KLIP_BASE_URL = `http://127.0.0.1:${PORT}/api`;
process.env.CACHE_TTL_SECONDS = '0';

let server: Server;
let state: MockState;
let reference: typeof import('../src/tools/klip/reference.js')['reference'];

const ctx = { requestId: 'vocabulary', userId: 'tester@example.com' };

beforeAll(async () => {
  state = freshState();
  ({ server } = await startMockKlip(PORT, state));
  reference = (await import('../src/tools/klip/reference.js')).reference;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('canonical vocabularies', () => {
  it('reports every incoterm KLIP has, not only those the sample happened to contain', async () => {
    const out = await reference.handler({ facet: 'incoterms' } as never, ctx);
    const data = out.data as {
      incoterms: Array<{ value: string; in_canonical_list: boolean; seen_in_sample: boolean }>;
      incoterms_source: string;
    };
    const canonical = data.incoterms.filter((i) => i.in_canonical_list).map((i) => i.value);
    expect(canonical).toEqual(['Blank', 'CFR', 'CIF', 'FOB', 'FRC', 'LCO']);
    expect(data.incoterms_source).toMatch(/canonical/i);
  });

  it('also reports a value found on rows but absent from the canonical list', async () => {
    // The fixture holds a contract with incoterm DAP, which KLIP's list omits. Reporting
    // only the canonical list would tell a user that contract's incoterm does not exist -
    // the exact failure this tool was built to prevent, in the opposite direction.
    const out = await reference.handler({ facet: 'incoterms' } as never, ctx);
    const data = out.data as {
      incoterms: Array<{ value: string; in_canonical_list: boolean }>;
      incoterms_outside_canonical?: string[];
      incoterms_outside_canonical_note?: string;
    };
    expect(data.incoterms.map((i) => i.value)).toContain('DAP');
    expect(data.incoterms.find((i) => i.value === 'DAP')?.in_canonical_list).toBe(false);
    expect(data.incoterms_outside_canonical).toContain('DAP');
    expect(String(data.incoterms_outside_canonical_note)).toMatch(/worth raising with KLIP/i);
  });

  it('marks which values the contract sample actually contained', async () => {
    // The gap between the two is the thing a sample can never tell you about itself.
    const out = await reference.handler({ facet: 'incoterms' } as never, ctx);
    const data = out.data as { incoterms: Array<{ value: string; seen_in_sample: boolean }> };
    const unseen = data.incoterms.filter((i) => !i.seen_in_sample).map((i) => i.value);
    expect(unseen.length).toBeGreaterThan(0);
  });

  it('names the incoterms it cannot compute an outstanding basis for', async () => {
    const out = await reference.handler({ facet: 'incoterms' } as never, ctx);
    const data = out.data as { incoterms_unclassified?: string[]; incoterms_unclassified_note?: string };
    // CFR and Blank are in KLIP's list and in neither basis group.
    expect(data.incoterms_unclassified).toContain('CFR');
    expect(data.incoterms_unclassified).toContain('Blank');
    expect(String(data.incoterms_unclassified_note)).toMatch(/EXCLUDED from outstanding totals/);
    // CIF is classified, so it must NOT appear.
    expect(data.incoterms_unclassified).not.toContain('CIF');
  });

  it('warns that a group-plant is not a physical site', async () => {
    // KLIP's canonical list collapses the two TJ.PURA sites that trucking distinguishes.
    // Presenting it as a site register would merge two plants into one total.
    const out = await reference.handler({ facet: 'plants' } as never, ctx);
    const data = out.data as { plants: Array<{ value: string }>; plants_source: string; plants_caveat: string };
    expect(data.plants.map((p) => p.value)).toContain('TJ PURA');
    expect(data.plants_source).toMatch(/canonical/i);
    expect(data.plants_caveat).toMatch(/not a site register/i);
  });
});

describe('facets with no canonical endpoint', () => {
  it('labels products, suppliers and statuses as sampled, not canonical', async () => {
    const out = await reference.handler({ facet: 'all' } as never, ctx);
    const data = out.data as Record<string, unknown>;
    for (const key of ['products_source', 'suppliers_source', 'statuses_source']) {
      expect(String(data[key])).toMatch(/sampled from contract rows/i);
      expect(String(data[key])).toMatch(/no .* filter-option endpoint/i);
    }
  });

  it('flags that the detail endpoint reports statuses outside the list vocabulary', async () => {
    const out = await reference.handler({ facet: 'statuses' } as never, ctx);
    expect(String((out.data as { statuses_caveat: string }).statuses_caveat)).toContain('ACTIVE');
  });
});

/**
 * klip_top_contracts - "which contracts have the most outstanding, and the latest one".
 *
 * KLIP's /contracts can sort by outstanding upstream, but that needs request options this
 * route map has not verified (an unknown option is IGNORED by KLIP, not rejected). So the
 * ranking is done HERE, over every row the walk returns, using only options this route
 * already verified: plant, product, status.
 *
 * The figure ranked is KLIP's own per-contract outstanding_quantity (kilograms, converted
 * once), not the gateway's cross-check - the same number the KLIP contract row shows.
 * Pages are fetched at KLIP's maximum size so the ranking covers the whole match; if the
 * walk still hits its bound, the result says so and the ranking covers the rows read.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt, toDateOnly } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, matchesLoosely } from './common.js';
import { assertFiltersRecognised } from './filterCheck.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 25;

const inputShape = {
  product: z.string().min(1).optional().describe('Product exactly as klip_reference reports it, e.g. "CPO".'),
  plant: z.string().min(1).optional().describe('Plant exactly as klip_reference reports it. Omit for all plants.'),
  status: z.string().min(1).default('Open').describe('Contract status, default "Open". Closed contracts carry no outstanding to chase.'),
  limit: z.number().int().min(1).max(CAP).default(10).describe(`How many contracts to return (max ${CAP}).`),
};

interface Ranked {
  contract_id: string;
  po_number: string | null;
  supplier: string | null;
  product: string | null;
  plant: string | null;
  incoterm: string | null;
  contract_date: string | null;
  quantity_ordered_mt: number | null;
  outstanding_mt: number;
}

export const topContracts: ToolDefinition<typeof inputShape> = {
  name: 'klip_top_contracts',
  title: 'KLIP contracts with the most outstanding',
  cap: CAP,
  description: describe(
    'Contracts ranked by KLIP\'s own outstanding quantity (MT), largest first, with supplier, plant, incoterm and ' +
      'contract date - plus the most recent contract that still has outstanding. Filter by product and plant; status ' +
      'defaults to Open. Use for "which contracts have the most outstanding". Every figure is KLIP\'s own, per ' +
      'contract; this tool only puts them in order and totals nothing. For SUPPLIERS with the most outstanding use ' +
      'klip_performance_summary with group_by supplier, which is KLIP\'s own supplier figure. The ranking covers every ' +
      'matching contract read from KLIP; if KLIP holds more than could be read, the result says so.',
    `Returns at most ${CAP} contracts.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    await assertFiltersRecognised({ product: params.product, plant: params.plant, status: params.status });
    const route = routes.contracts;
    const filters = buildFilters(route, { product: params.product, plant: params.plant, status: params.status });

    const cached = await cache.through(
      cache.keyFor('klip_top_contracts', { product: params.product, plant: params.plant, status: params.status }),
      async () => walk<Row>({ route, filters: filters.upstream, pageSize: route.maxLimit }),
    );
    const walked = cached.value;
    const f = fields.contract;

    const rows: Ranked[] = [];
    for (const row of walked.rows) {
      // Anything KLIP could not take upstream is applied here, as everywhere else.
      if (filters.local.includes('product') && !matchesLoosely(pickString(row, f.product), params.product)) continue;
      if (filters.local.includes('plant') && !matchesLoosely(pickString(row, f.plant), params.plant)) continue;
      if (filters.local.includes('status') && (pickString(row, f.status) ?? '').toLowerCase() !== params.status.toLowerCase()) continue;
      const os = kgToMt(pickNumber(row, f.outstandingUpstream));
      if (os === null || os <= 0) continue;
      rows.push({
        contract_id: pickString(row, f.id) ?? '(unknown)',
        po_number: pickString(row, f.poNumber),
        supplier: pickString(row, f.supplier),
        product: pickString(row, f.product),
        plant: pickString(row, f.plant),
        incoterm: pickString(row, f.incoterm),
        contract_date: toDateOnly(pickString(row, f.contractDate)),
        quantity_ordered_mt: kgToMt(pickNumber(row, f.qtyPo)),
        outstanding_mt: os,
      });
    }

    const ranked = [...rows].sort((a, b) => b.outstanding_mt - a.outstanding_mt);
    const latest = [...rows].filter((r) => r.contract_date !== null).sort((a, b) => String(b.contract_date).localeCompare(String(a.contract_date)))[0] ?? null;
    // No supplier totals here: KLIP publishes its own supplier figure (Contract Performance),
    // and a second one summed by the gateway would sit beside it and disagree. KLIP is the one
    // source; klip_performance_summary group_by supplier reports KLIP's.

    const data: Record<string, unknown> = {
      filter: { product: params.product ?? 'all', plant: params.plant ?? 'all', status: params.status },
      contracts: ranked.slice(0, params.limit),
      latest_contract: latest,
      ranked_from_contracts: rows.length,
      source:
        'KLIP /contracts rows; outstanding is KLIP\'s own outstanding_quantity per contract, converted from kg to MT. ' +
        'Ordered here, because KLIP\'s own sort options are not yet verified for this connector. Nothing is totalled.',
      suppliers: 'For the suppliers with the most outstanding, use klip_performance_summary with group_by supplier - KLIP\'s own figure.',
    };
    if (walked.truncated) {
      data.coverage_warning =
        `KLIP holds more matching contracts than could be read (${walked.fetchedRows} of ${walked.totalRows ?? 'an unknown number'}). ` +
        'The ranking covers the contracts read; narrow by plant for a complete ranking.';
    }

    return {
      data,
      units: 'MT',
      rowCount: Math.min(ranked.length, params.limit),
      truncated: walked.truncated,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      coverage: { fetched_rows: walked.fetchedRows, total_rows: walked.totalRows, pages_fetched: walked.pagesFetched, total_pages: walked.totalPages },
      klipCalls: walked.calls,
      nextStep: walked.truncated ? 'Narrow by plant: the ranking covers only the contracts read.' : undefined,
    };
  },
};

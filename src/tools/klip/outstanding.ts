/**
 * klip_outstanding - "How much CPO is still outstanding at Tanjung Pura?"
 *
 * The money tool. Three review findings land here:
 *
 *   H4.1  When the fetch is truncated the figures are published under
 *         `totals_partial`, never `totals`. A field called "totals" over a partial
 *         set is the single most likely way this connector states a wrong number
 *         with confidence.
 *   H4.2  All arithmetic is in kilograms; kg -> MT happens once, on the finished
 *         aggregate. Per-line rounding then summing drifts from the KLIP UI.
 *   H5    The walk is cached and its pages are fetched concurrently, because ten
 *         sequential round-trips cannot meet the P95 <= 5 s target.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { type Row } from './../../adapters/klip/fields.js';
import {
  aggregateOutstanding,
  groupByIncoterm,
  kgToMt,
  outstanding as outstandingFor,
  topByOutstanding,
} from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, countNotes, localFilterNote, matchesLoosely } from './common.js';
import { assertFiltersRecognised } from './filterCheck.js';
import { toContractLine } from './searchContracts.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const TOP_N = 20;

const inputShape = {
  plant: z.string().min(1).optional().describe('Plant name exactly as klip_reference reports it.'),
  product: z.string().min(1).optional().describe('Product name, e.g. "CPO".'),
  incoterm: z
    .string()
    .min(1)
    .optional()
    .describe('Restrict to one incoterm (FOB, Loco, Franco or CIF as klip_reference reports them).'),
  as_of_basis: z
    .literal('current')
    .default('current')
    .describe('Fixed to "current" in Phase 1: there is no historical replay.'),
};

export const outstanding: ToolDefinition<typeof inputShape> = {
  name: 'klip_outstanding',
  title: 'KLIP outstanding quantities',
  cap: TOP_N,
  description: describe(
    'Outstanding (not yet delivered) contract quantities in metric tonnes, using the Incoterm-correct basis: ' +
      'FOB and Loco measure against quantity shipped, Franco and CIF against quantity received, and cancelled ' +
      'contracts count as zero. Answers "how much is still open at plant X?". ' +
      'Contracts whose incoterm or quantities cannot be interpreted are excluded from the totals and reported ' +
      'under data_quality rather than silently counted as zero - always mention exclusions when they are present. ' +
      'Resolve plant and product wording with klip_reference first.',
    `Returns aggregate totals plus the top ${TOP_N} contracts by outstanding quantity.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.contracts;

    const filterInput = { plant: params.plant, product: params.product };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(
      cache.keyFor('klip_outstanding', { ...filterInput, incoterm: params.incoterm }),
      async () => walk<Row>({ route, filters: filters.upstream }),
    );
    const walked = cached.value;

    let lines = walked.rows.map((row) => outstandingFor(toContractLine(row)));

    if (filters.local.length > 0) {
      lines = lines.filter(
        (l) =>
          (!filters.local.includes('plant') || matchesLoosely(l.plant, params.plant)) &&
          (!filters.local.includes('product') || matchesLoosely(l.product, params.product)),
      );
    }
    if (params.incoterm !== undefined) {
      const wanted = params.incoterm.trim().toLowerCase();
      lines = lines.filter((l) => (l.incoterm ?? '').trim().toLowerCase() === wanted);
    }

    const totals = aggregateOutstanding(lines);
    const byIncoterm = groupByIncoterm(lines);
    const top = topByOutstanding(lines, TOP_N).map((l) => ({
      contract_id: l.contract_id,
      po_number: l.po_number,
      supplier: l.supplier,
      product: l.product,
      plant: l.plant,
      incoterm: l.incoterm,
      status: l.status,
      basis: l.basis,
      qty_po_mt: kgToMt(l.qty_po_kg),
      basis_qty_mt: kgToMt(l.basis_qty_kg),
      outstanding_mt: kgToMt(l.outstanding_kg),
      data_quality: l.data_quality,
    }));

    // H4.1: the key name itself tells the model whether this is a complete total.
    const totalsKey = walked.truncated ? 'totals_partial' : 'totals';

    const data: Record<string, unknown> = {
      [totalsKey]: {
        qty_po_mt: totals.qty_po_mt,
        shipped_mt: totals.shipped_mt,
        received_mt: totals.received_mt,
        outstanding_mt: totals.outstanding_mt,
        contracts: totals.contracts,
        excluded_from_outstanding: totals.excluded_lines,
      },
      by_incoterm: byIncoterm,
      top_contracts: top,
      rounding: 'Quantities are summed in kilograms and converted to MT once, rounded to 3 decimal places. ' +
        'Per-contract MT figures may not add exactly to the total for that reason.',
    };

    if (walked.truncated) {
      data.partial_totals_warning =
        `These figures are labelled ${totalsKey} because the contract fetch hit its page bound ` +
        `(${walked.fetchedRows} of ${walked.totalRows ?? 'an unknown number of'} rows read). ` +
        'They are NOT a complete outstanding total. Ask the user to narrow by plant, product or date range, ' +
        'and do not quote these numbers as the answer.';
    }

    if (totals.excluded_lines > 0) {
      data.exclusions_note =
        `${totals.excluded_lines} of ${totals.contracts} contracts are excluded from outstanding_mt because an ` +
        'incoterm was unrecognised or a quantity was missing. Their outstanding quantity is unknown, not zero.';
    }

    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;

    if (totals.contracts === 0) {
      // The "nothing is outstanding at that plant" lie is the worst failure this
      // tool can produce, so an empty result must first prove the filters were real.
      await assertFiltersRecognised({ plant: params.plant, product: params.product });
      data.empty_result_note =
        'No contracts matched. The plant and product values are recognised by KLIP, so nothing is currently ' +
        'outstanding for this filter.';
    }

    return {
      data,
      units: 'MT',
      rowCount: top.length,
      truncated: walked.truncated,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      coverage: {
        fetched_rows: walked.fetchedRows,
        total_rows: walked.totalRows,
        pages_fetched: walked.pagesFetched,
        total_pages: walked.totalPages,
      },
      dataQuality: countNotes(lines),
      klipCalls: walked.calls,
    };
  },
};

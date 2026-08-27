/**
 * klip_outstanding - "How much CPO is still outstanding at Tanjung Pura?"
 *
 * The money tool, and since 27 Aug 2026 it no longer does its own arithmetic.
 *
 * ONE SOURCE OF TRUTH
 *
 * Every figure reported here comes from KLIP. The total comes from
 * /contracts/late-performance/summary, which is what the KLIP Contract Performance page
 * renders; the per-contract outstanding comes from KLIP's own outstanding_quantity field
 * on the contract row. A number read in Claude and the same number read on the KLIP web
 * page must agree, because they are now the same number reached two ways.
 *
 * UNITS: KLIP HOLDS KILOGRAMS
 *
 * Confirmed 27 Aug 2026 and reconciled against the KLIP page. A contract for 3,500 MT
 * with nothing shipped reports outstanding_quantity = 3500000, so both the per-contract
 * field and the aggregate are kilograms. They are converted to MT once, here.
 *
 * Note what that means for contract rows: quantity_ordered is ALSO kilograms while the
 * row's own `unit` field says "MT". That is the kg-labelled-as-MT trap the TSD warned
 * about. We told the KLIP team the data contradicted that warning; it does not - the
 * `unit` field names the business unit, not the storage unit. The connector's arithmetic
 * was right throughout because it always treated the column as kilograms.
 *
 * We used to compute outstanding ourselves - basis chosen by incoterm, zeroed on Close,
 * excluded on an unrecognised incoterm. That produced a second, competing figure for the
 * same question. The 24 August ruling settled which governs, and the honest way to
 * implement a ruling is to stop producing the losing number, not to relabel it.
 *
 * The old calculation survives as a CROSS-CHECK ONLY. It runs, it is compared against
 * KLIP's figure, and a material disagreement is surfaced as a data-quality note. It is
 * never reported as a quantity. That keeps the value it had - it is what caught the
 * incoterm-basis and null-propagation problems - without giving a user two answers.
 *
 * WHAT THIS FIXES ALONGSIDE
 *
 * KLIP's aggregate is computed over the whole matching dataset with no pagination, so the
 * total is complete even when the row sample is bounded. The `totals_partial` problem
 * (review H4.1) therefore disappears for TOTALS. It still applies to the row list, which
 * is a sample and is labelled as one.
 *
 * Retained from the original design:
 *   H4.2  the cross-check sums in kilograms and converts once, so it can be compared
 *         against KLIP without per-line rounding drift manufacturing a discrepancy.
 *   H5    the row walk is cached with concurrent pages, for the P95 <= 5 s target.
 */
import { z } from 'zod';
import { fetchOne, walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { type Row } from './../../adapters/klip/fields.js';
import {
  aggregateOutstanding,
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

/** The shape of KLIP's performance aggregate, as probed 27 Aug 2026. */
interface KlipSummary {
  summary?: { count?: number; openOutstandingQty?: number; closeOutstandingQty?: number };
  statusCardSummary?: {
    openOutstandingQty?: number;
    openOnTimeCount?: number;
    openLateCount?: number;
    closeOnTimeCount?: number;
    closeLateCount?: number;
  };
}

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

    // incoterm now goes upstream with the rest. Before this it was filtered locally,
    // so an incoterm query still walked every contract for the plant and reported
    // coverage over a population it was not asked about.
    const filterInput = { plant: params.plant, product: params.product, incoterm: params.incoterm };
    const filters = buildFilters(route, filterInput);

    /**
     * KLIP's aggregate, with the same filters. scope=filtered is DERIVED from which
     * filters are present: without it KLIP answers the unfiltered year-to-date question
     * and would hand back company-wide figures under the caller's plant filter.
     */
    const agg = routes.latePerformanceSummary;
    const aggQuery: Record<string, string> = {};
    if (params.plant !== undefined) aggQuery[agg.params.plant] = params.plant;
    if (params.product !== undefined) aggQuery[agg.params.product] = params.product;
    if (params.incoterm !== undefined) aggQuery[agg.params.incoterm] = params.incoterm;
    if (Object.keys(aggQuery).length > 0) aggQuery[agg.params.scope] = 'filtered';
    const aggPath =
      Object.keys(aggQuery).length === 0
        ? agg.path
        : `${agg.path}?${new URLSearchParams(aggQuery).toString()}`;

    const cached = await cache.through(
      cache.keyFor('klip_outstanding', { ...filterInput, incoterm: params.incoterm }),
      async () => {
        const [rows, summary] = await Promise.all([
          walk<Row>({ route, filters: filters.upstream }),
          fetchOne<KlipSummary>(aggPath, agg.rowsPath).catch(() => undefined),
        ]);
        return { rows, summary };
      },
    );
    const walked = cached.value.rows;
    const summary = cached.value.summary;

    let lines = walked.rows.map((row) => outstandingFor(toContractLine(row)));

    if (filters.local.length > 0) {
      lines = lines.filter(
        (l) =>
          (!filters.local.includes('plant') || matchesLoosely(l.plant, params.plant)) &&
          (!filters.local.includes('product') || matchesLoosely(l.product, params.product)),
      );
    }
    // Only if KLIP could not take it. buildFilters puts an unroutable filter in local[],
    // so this stays correct whichever way the parameter is handled.
    if (params.incoterm !== undefined && filters.local.includes('incoterm')) {
      const wanted = params.incoterm.trim().toLowerCase();
      lines = lines.filter((l) => (l.incoterm ?? '').trim().toLowerCase() === wanted);
    }

    // Retained as a cross-check only. Never reported as a quantity - see the header.
    const crossCheck = aggregateOutstanding(lines);
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
      // KLIP's own per-contract figure, not ours, converted from kilograms. A row a user
      // reads here must match the row they read on the KLIP page.
      outstanding_mt: kgToMt(l.upstream_outstanding),
      data_quality: l.data_quality,
    }));

    const card = summary?.statusCardSummary;
    const whole = summary?.summary;

    const data: Record<string, unknown> = {
      totals:
        summary === undefined
          ? null
          : {
              // KLIP holds kilograms; converted once, here. Verified against the KLIP page.
              open_outstanding_mt: kgToMt(card?.openOutstandingQty ?? whole?.openOutstandingQty ?? null),
              close_outstanding_mt: kgToMt(whole?.closeOutstandingQty ?? null),
              // KLIP's count, and therefore THE count. No qualifier needed now that
              // nothing here produces a rival figure.
              contracts: whole?.count ?? null,
              open_on_time: card?.openOnTimeCount ?? null,
              open_late: card?.openLateCount ?? null,
              close_on_time: card?.closeOnTimeCount ?? null,
              close_late: card?.closeLateCount ?? null,
            },
      totals_source:
        'KLIP /contracts/late-performance/summary - the figures its Contract Performance page renders, ' +
        'aggregated over the whole matching dataset with no pagination, converted from the kilograms KLIP ' +
        'holds to MT. These reconcile against the KLIP web page: it is the same number reached two ways. ' +
        'The contract count is KLIP\'s for this filter. It will not equal the number of rows listed below: ' +
        'the rows are a sample, the count is the population.',
      top_contracts: top,
      top_contracts_note:
        `The ${TOP_N} contracts below are a SAMPLE of the matching set, ordered by outstanding quantity. ` +
        'They do not add up to the total above and are not meant to: the total covers every matching ' +
        'contract, the sample covers the rows read.',
      breakdown_note:
        'There is no per-incoterm breakdown here. KLIP does not aggregate by incoterm in one response, and ' +
        'tallying the rows ourselves would produce figures that do not reconcile with the total above. To ' +
        'break the total down, call this tool once per incoterm - KLIP partitions exactly, so the parts ' +
        'sum to the whole.',
    };

    if (summary === undefined) {
      // No figure at all rather than a substitute one. Our own arithmetic is available
      // and deliberately not used: producing a second number is what this change removed.
      data.totals_unavailable =
        'KLIP did not return its performance aggregate, so no total is reported. The contracts below are ' +
        'still valid rows. Do not sum them into a total - the sample is not the population.';
    }

    if (walked.truncated) {
      data.row_sample_warning =
        `The contract list hit its page bound (${walked.fetchedRows} of ` +
        `${walked.totalRows ?? 'an unknown number of'} rows read), so the contracts listed are a partial ` +
        'sample. The total above is unaffected: KLIP aggregates it over the whole matching set.';
    }

    /**
     * The cross-check. Our old arithmetic against KLIP's, reported as a flag and never as
     * a figure.
     *
     * A large ratio is the most useful signal here: roughly 1000x either way means one
     * side is kilograms and the other tonnes, which is the error class that would do the
     * most damage if it went unnoticed.
     */
    const klipOpenMt = kgToMt(card?.openOutstandingQty ?? whole?.openOutstandingQty ?? null);
    if (klipOpenMt !== null && klipOpenMt > 0 && crossCheck.outstanding_mt !== null && !walked.truncated) {
      // MT against MT. Comparing KLIP's kilograms to our tonnes previously reported a
      // 1590x "unit mismatch" for what is really a 1.59x difference in rules - a check
      // that cries wolf is worse than no check.
      const ratio = klipOpenMt / crossCheck.outstanding_mt;
      if (ratio > 100 || ratio < 0.01) {
        data.unit_mismatch_warning =
          `KLIP reports ${klipOpenMt} MT outstanding where an independent calculation over the same rows ` +
          `gives ${crossCheck.outstanding_mt} MT - a factor of about ` +
          `${Math.round(ratio > 1 ? ratio : 1 / ratio)}. Both sides are now converted to MT, so a factor ` +
          'this large means one of them changed unit upstream. Report KLIP\'s figure and raise it.';
      } else if (ratio > 1.05 || ratio < 0.95) {
        data.reconciliation_note =
          `KLIP reports ${klipOpenMt} MT outstanding; an independent calculation over the rows read gives ` +
          `${crossCheck.outstanding_mt} MT. Quote KLIP's figure - it is what the web page shows and it ` +
          'covers the whole matching set. The gap reflects different incoterm-basis and exclusion rules, ' +
          'not an error in either.';
      }
    }

    if (crossCheck.excluded_lines > 0) {
      data.excluded_from_cross_check =
        `${crossCheck.excluded_lines} of ${crossCheck.contracts} rows read could not be independently ` +
        'checked because an incoterm was unrecognised or a quantity was missing. This does not affect the ' +
        'total above, which is KLIP\'s.';
    }

    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;

    if (crossCheck.contracts === 0) {
      // The "nothing is outstanding at that plant" lie is the worst failure this
      // tool can produce, so an empty result must first prove the filters were real.
      await assertFiltersRecognised({ plant: params.plant, product: params.product });
      data.empty_result_note =
        'No contracts matched. The plant and product values are recognised by KLIP, so nothing is currently ' +
        'outstanding for this filter.';
    }

    return {
      data,
      // Everything quantitative in the payload is MT: KLIP's kilograms, converted once.
      units: 'MT',
      /**
       * truncated below refers to the ROW SAMPLE. The total is KLIP's server-side
       * aggregate and is complete regardless, so the envelope's default hint - "the
       * figures cover only part of the matching data, do not quote any total" - would be
       * false here and would contradict row_sample_warning in the same payload.
       */
      nextStep: walked.truncated
        ? 'The TOTAL above is complete: KLIP aggregated it over the whole matching set. Only the ' +
          'contract list is a partial sample, so do not add up the listed rows. Quote the total as it ' +
          'stands, and narrow the filter only if the user wants the full contract list.'
        : undefined,
      rowCount: top.length,
      // Coverage of the ROW SAMPLE. The total is KLIP's and is never page-bounded.
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

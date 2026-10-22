/**
 * klip_outstanding_breakdown - "Outstanding CPO per plant and per incoterm" in ONE call.
 *
 * klip_outstanding answers one cell (one plant, one incoterm) per call. A plant x incoterm
 * table is ~40 plants x 4 incoterms, so an agent building it cell by cell runs out of budget
 * long before the table is done - which is exactly what Milo's Atlas hit on 20 Oct 2026.
 *
 * SAME SOURCE OF TRUTH AS klip_outstanding
 *
 * Every cell is KLIP's own aggregate (/contracts/late-performance/summary) with that cell's
 * filters - the figure klip_outstanding reports for the same filters, and the figure the KLIP
 * Contract Performance page renders. Nothing is summed from contract rows. The row walk is
 * used only to DISCOVER which plant/incoterm combinations exist for the product, so KLIP is
 * not asked about ~160 empty cells.
 *
 * The whole (product-only) aggregate is reported beside the parts. When the parts do not add
 * up to the whole, both are reported as KLIP gives them and the difference is named - never
 * adjusted, never redistributed.
 */
import { z } from 'zod';
import { fetchOne, walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt } from './../../adapters/klip/normalize.js';
import type { CallRecord } from './../../adapters/klip/session.js';
import * as cache from './../../core/cache.js';
import { cfg } from './../../core/config.js';
import { invalidParams } from './../../core/errors.js';
import { mapLimit } from './../../core/semaphore.js';
import { buildFilters } from './common.js';
import { assertFiltersRecognised } from './filterCheck.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

/** Upper bound on KLIP aggregate calls for one breakdown. */
const MAX_CELLS = 160;
const CONCURRENCY = 4;

/**
 * KLIP's own placeholders for a missing value (Logistic SAP sapDisplayValue.ts). A contract
 * with no plant carries the literal "Blank"; sent as plant=Blank the aggregate does not
 * recognise it, IGNORES it and answers for the whole product - so the "Blank" cell came back
 * as an exact copy of the total and the cells summed to double it (CPO, 22 Oct 2026:
 * 746,068 MT against 373,034). KLIP's own drilldown leaves these contracts out.
 */
const KLIP_EMPTY_VALUES = new Set(['unknown', 'blank', 'null', 'undefined', 'n/a', 'na', 'none', '-', '—']);
const isPlaceholder = (v: string | null): boolean => v === null || KLIP_EMPTY_VALUES.has(v.trim().toLowerCase());

interface KlipSummary {
  summary?: { count?: number; openOutstandingQty?: number; closeOutstandingQty?: number };
  statusCardSummary?: { openOutstandingQty?: number; openOnTimeCount?: number; openLateCount?: number; closeOnTimeCount?: number; closeLateCount?: number };
}

interface Cell {
  plant: string | null;
  incoterm: string | null;
  open_outstanding_mt: number | null;
  close_outstanding_mt: number | null;
  late_contracts: number | null;
  open_late: number | null;
  open_on_time: number | null;
}

const inputShape = {
  product: z.string().min(1).optional().describe('Product exactly as klip_reference reports it, e.g. "CPO". Omit for all products.'),
  by: z
    .enum(['plant', 'incoterm', 'plant_incoterm'])
    .default('plant_incoterm')
    .describe('Split by plant, by incoterm, or both (one row per plant and incoterm that has contracts).'),
  include_empty: z.boolean().default(false).describe('Also list cells whose open and close outstanding are both zero.'),
  all_time: z
    .boolean()
    .default(false)
    .describe('Count every contract ever. Default false: year to date, the window the KLIP page shows.'),
};

/**
 * Year to date in WIB, as klip_performance_summary and the KLIP page use. With scope=filtered
 * and no dates KLIP applies NO window, so a breakdown without these reported all-time
 * figures beside a page showing year-to-date ones (CPO 475,367 vs 417,369 MT, 10 Sep 2026).
 */
function ytdWindow(now = Date.now()): { from: string; to: string } {
  const wib = new Date(now + 7 * 60 * 60 * 1000);
  const to = wib.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

function aggPath(
  filters: { plant?: string | null; product?: string | undefined; incoterm?: string | null },
  window?: { from: string; to: string },
): string {
  const agg = routes.latePerformanceSummary;
  const q: Record<string, string> = {};
  if (window !== undefined) { q[agg.params.dateFrom] = window.from; q[agg.params.dateTo] = window.to; }
  if (filters.plant) q[agg.params.plant] = filters.plant;
  if (filters.product) q[agg.params.product] = filters.product;
  if (filters.incoterm) q[agg.params.incoterm] = filters.incoterm;
  // Without scope=filtered KLIP answers the unfiltered question under the caller's filter.
  if (filters.plant || filters.product || filters.incoterm) q[agg.params.scope] = 'filtered';
  return Object.keys(q).length === 0 ? agg.path : `${agg.path}?${new URLSearchParams(q).toString()}`;
}

function toCell(plant: string | null, incoterm: string | null, s: KlipSummary | undefined): Cell {
  const card = s?.statusCardSummary;
  const whole = s?.summary;
  return {
    plant,
    incoterm,
    // statusCardSummary, not summary: summary covers the LATE cohort only (see klip_outstanding).
    open_outstanding_mt: kgToMt(card?.openOutstandingQty ?? null),
    close_outstanding_mt: kgToMt(whole?.closeOutstandingQty ?? null),
    late_contracts: whole?.count ?? null,
    open_late: card?.openLateCount ?? null,
    open_on_time: card?.openOnTimeCount ?? null,
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

export const outstandingBreakdown: ToolDefinition<typeof inputShape> = {
  name: 'klip_outstanding_breakdown',
  title: 'KLIP outstanding by plant and incoterm',
  cap: MAX_CELLS,
  description: describe(
    'Outstanding contract quantity in metric tonnes SPLIT by plant, by incoterm, or by plant AND incoterm, ' +
      'for one product or all, in ONE call - use this instead of calling klip_outstanding once per plant or ' +
      'incoterm. Every cell is KLIP\'s own figure for that plant/incoterm (the same one klip_outstanding and ' +
      'the KLIP Contract Performance page report), plus KLIP\'s total for the whole product beside it. ' +
      'If the cells do not add up to the total, both are given as KLIP holds them and the difference is ' +
      'stated - report it that way and never adjust either side.',
    `Returns at most ${MAX_CELLS} cells, largest open outstanding first; empty cells are left out unless asked for.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    await assertFiltersRecognised({ product: params.product });
    const calls: CallRecord[] = [];
    const window = params.all_time ? undefined : ytdWindow();

    const cached = await cache.through(
      cache.keyFor('klip_outstanding_breakdown', { product: params.product, by: params.by, from: window?.from, to: window?.to }),
      async () => {
        // 1) Which plants and incoterms actually have contracts for this product.
        //    Pages at the route's maximum, so the walk covers ten times the rows it used to.
        const filters = buildFilters(routes.contracts, { product: params.product });
        const walked = await walk<Row>({ route: routes.contracts, filters: filters.upstream, pageSize: routes.contracts.maxLimit, calls });
        // KLIP's own complete lists. Plants found on rows must be on KLIP's list, and when the
        // walk cannot see every row, a one-dimension split asks about the whole list instead
        // (empty cells are dropped below), so no plant or incoterm goes missing.
        const [canonicalPlants, canonicalIncoterms] = await Promise.all([
          params.by === 'incoterm' ? undefined : fetchOne<string[]>(routes.filterOptionsGroupPlants.path, routes.filterOptionsGroupPlants.rowsPath, calls).catch(() => undefined),
          params.by === 'plant' ? undefined : fetchOne<string[]>(routes.filterOptionsIncoterms.path, routes.filterOptionsIncoterms.rowsPath, calls).catch(() => undefined),
        ]);
        const knownPlant = Array.isArray(canonicalPlants) ? new Set(canonicalPlants.map((p) => p.trim().toUpperCase())) : undefined;
        const wantedProduct = params.product?.trim().toLowerCase();
        const pairs = new Map<string, { plant: string | null; incoterm: string | null }>();
        for (const row of walked.rows) {
          if (wantedProduct !== undefined && filters.local.includes('product')) {
            const p = pickString(row, fields.contract.product);
            if (p === null || !p.toLowerCase().includes(wantedProduct)) continue;
          }
          const plant = params.by === 'incoterm' ? null : pickString(row, fields.contract.plant)?.trim() || null;
          const incoterm = params.by === 'plant' ? null : pickString(row, fields.contract.incoterm)?.trim() || null;
          if ((params.by !== 'incoterm' && plant === null) || (params.by !== 'plant' && incoterm === null)) continue;
          if (params.by !== 'incoterm' && (isPlaceholder(plant) || (knownPlant !== undefined && !knownPlant.has((plant ?? '').toUpperCase())))) continue;
          pairs.set(`${plant ?? ''}|${incoterm ?? ''}`, { plant, incoterm });
        }
        let discoveredFrom = 'contract rows';
        let discoveryComplete = !walked.truncated;
        if (walked.truncated && params.by === 'plant' && Array.isArray(canonicalPlants)) {
          pairs.clear();
          for (const p of canonicalPlants) if (!isPlaceholder(p)) pairs.set(`${p}|`, { plant: p, incoterm: null });
          discoveredFrom = 'KLIP filter-options/group-plants (the contract list was too long to read whole)';
          discoveryComplete = true;
        } else if (walked.truncated && params.by === 'incoterm' && Array.isArray(canonicalIncoterms)) {
          pairs.clear();
          for (const i of canonicalIncoterms) pairs.set(`|${i}`, { plant: null, incoterm: i });
          discoveredFrom = 'KLIP filter-options/incoterms (the contract list was too long to read whole)';
          discoveryComplete = true;
        }
        const all = [...pairs.values()].sort((a, b) => `${a.plant}${a.incoterm}`.localeCompare(`${b.plant}${b.incoterm}`));
        const asked = all.slice(0, MAX_CELLS);

        // 2) KLIP's aggregate for the whole, then for each cell.
        const whole = await fetchOne<KlipSummary>(aggPath({ product: params.product }, window), routes.latePerformanceSummary.rowsPath, calls).catch(() => undefined);
        const cells = await mapLimit(asked, CONCURRENCY, async (c) =>
          toCell(c.plant, c.incoterm, await fetchOne<KlipSummary>(aggPath({ ...c, product: params.product }, window), routes.latePerformanceSummary.rowsPath, calls).catch(() => undefined)),
        );
        return {
          whole: toCell(null, null, whole),
          wholeAvailable: whole !== undefined,
          cells,
          combinations: all.length,
          skipped: all.length - asked.length,
          walkTruncated: walked.truncated,
          walkFetched: walked.fetchedRows,
          walkTotal: walked.totalRows,
          discoveredFrom,
          discoveryComplete,
        };
      },
      { ttlSeconds: cfg.KLIP_BREAKDOWN_CACHE_TTL_SECONDS },
    );

    const v = cached.value;
    if (v.cells.length === 0 && !v.wholeAvailable) {
      throw invalidParams('KLIP returned no outstanding figures for this filter. Check the product name with klip_reference.');
    }
    // A cell identical to the whole product, while other cells hold quantity too, is KLIP
    // having IGNORED that cell's filter (it answers an unknown value with the unfiltered
    // figure). Rejected and named, never shown as a figure: it is not that cell's number.
    // A product genuinely in one cell is untouched - there is no other non-empty cell.
    const w = v.whole;
    const isWhole = (c: Cell): boolean =>
      v.wholeAvailable && c.open_outstanding_mt !== null &&
      c.open_outstanding_mt === w.open_outstanding_mt && c.close_outstanding_mt === w.close_outstanding_mt &&
      c.late_contracts === w.late_contracts;
    const nonEmpty = (c: Cell): boolean => (c.open_outstanding_mt ?? 0) !== 0 || (c.close_outstanding_mt ?? 0) !== 0 || (c.late_contracts ?? 0) !== 0;
    const rejected = v.cells.filter((c) => isWhole(c) && v.cells.some((o) => o !== c && nonEmpty(o)));
    const cells = v.cells.filter((c) => !rejected.includes(c));

    const failed = cells.filter((c) => c.open_outstanding_mt === null && c.close_outstanding_mt === null).length;
    const shown = cells
      .filter((c) => params.include_empty || (c.open_outstanding_mt ?? 0) !== 0 || (c.close_outstanding_mt ?? 0) !== 0)
      .sort((a, b) => (b.open_outstanding_mt ?? 0) - (a.open_outstanding_mt ?? 0));

    const sumOpen = cells.reduce((s, c) => s + (c.open_outstanding_mt ?? 0), 0);
    const sumClose = cells.reduce((s, c) => s + (c.close_outstanding_mt ?? 0), 0);
    const wholeOpen = v.whole.open_outstanding_mt;
    const reconciles = wholeOpen !== null && v.skipped === 0 && failed === 0 && v.discoveryComplete
      ? Math.abs(sumOpen - wholeOpen) <= Math.max(0.5, Math.abs(wholeOpen) * 0.005)
      : null;

    const data: Record<string, unknown> = {
      product: params.product ?? 'all products',
      split_by: params.by,
      period: window ? `Year to date, ${window.from} to ${window.to} - the window the KLIP page uses by default.` : 'All time (every contract ever), as asked.',
      total: v.wholeAvailable
        ? { open_outstanding_mt: v.whole.open_outstanding_mt, close_outstanding_mt: v.whole.close_outstanding_mt, late_contracts: v.whole.late_contracts }
        : null,
      cells: shown,
      cells_listed: shown.length,
      cells_with_contracts: v.combinations,
      reconciliation: {
        sum_of_cells_open_mt: round(sumOpen),
        sum_of_cells_close_mt: round(sumClose),
        total_open_mt: wholeOpen,
        cells_add_up_to_total: reconciles,
        note: reconciles === true
          ? 'The cells add up to KLIP\'s total.'
          : reconciles === false
            ? `The cells sum to ${round(sumOpen)} MT open against KLIP's total of ${wholeOpen} MT. Both are KLIP's own figures; report them side by side and do not adjust either.`
            : 'Not checked: some cells were skipped, failed or the contract list was partial (see below).',
      },
      source:
        'Every cell and the total are KLIP /contracts/late-performance/summary for that filter - the figures ' +
        'the KLIP Contract Performance page renders - converted from kilograms to MT. Nothing is summed from rows.',
    };
    if (v.skipped > 0) data.cells_skipped = `${v.skipped} more combinations exist than the ${MAX_CELLS}-cell limit allows; narrow by product.`;
    if (failed > 0) data.cells_failed = `${failed} cells returned no figure from KLIP and are shown as null.`;
    if (rejected.length > 0) {
      data.cells_rejected = rejected.map((c) => ({
        plant: c.plant,
        incoterm: c.incoterm,
        reason: 'KLIP answered with the whole-product figure, so it ignored this filter value. Not this cell\'s number; left out of the cells and the sum.',
      }));
    }
    data.cells_found_from = v.discoveredFrom;
    if (!v.discoveryComplete) {
      data.discovery_warning =
        `The contract list used to find which plant/incoterm combinations exist hit its page bound (${v.walkFetched} of ` +
        `${v.walkTotal ?? 'an unknown number of'} rows), so a combination may be missing from the table. ` +
        'The total is unaffected.';
    }

    return {
      data,
      units: 'MT',
      rowCount: shown.length,
      truncated: v.skipped > 0,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      klipCalls: calls,
      nextStep: v.skipped > 0 ? 'Narrow by product to see every combination.' : undefined,
    };
  },
};

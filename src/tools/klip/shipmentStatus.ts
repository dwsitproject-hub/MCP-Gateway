/**
 * klip_shipment_status - the KLIP Shipments page.
 *
 * Rebuilt 28 Aug 2026 after the user reported that the Bontang summary did not agree
 * with the Shipments page. It did not, and for three separable reasons. All three are
 * recorded here because each was a different kind of mistake.
 *
 * 1. THE TOOL COULD NOT ASK THE QUESTION. There was no `plant` input, and one of
 *    sto_number/vessel_name/contract_id was mandatory. "Shipment status for Bontang" was
 *    therefore unaskable, and a live chat answered it from /shipments/performance
 *    instead - a different endpoint, a different row set, and a status vocabulary of
 *    four values against this page's eight. It reported 56 on-going rows where KLIP
 *    reports 143 shipments for Bontang.
 *
 * 2. TWO DECLARED FILTERS DID NOTHING. stoNumber and vesselName were declared as
 *    upstream parameters. KLIP ignores both - measured, 428 rows either way - and
 *    buildFilters() skips its local pass for anything it believes went upstream. So
 *    klip_shipment_status(vessel_name: X) returned the first rows of the WHOLE table and
 *    presented them as that vessel's. They are now absent from the route contract, which
 *    routes them to the local pass that actually applies them.
 *
 * 3. THE FIELD MAP INVENTED A DEFECT. See fields.shipment. eta_arrival is the ETA at the
 *    LOADING port and eta_sailed the departure from it; mapped to a bare eta/etd pair
 *    they read as departure-before-arrival, and that went to the user as a systematic
 *    KLIP column swap, "seven for seven". Measured over Bontang, eta_arrival <=
 *    eta_sailed on 51 of 52 rows. Meanwhile the real actuals in ata_vessel_* were never
 *    read at all, so every ATA came back null and that was reported as missing data.
 *
 * KLIP OWNS THE COUNTS. data.summary is the Shipments page's own status breakdown and is
 * reported as-is. This connector does not recount rows into a rival figure - the same
 * rule that settled klip_outstanding. Where the summary disagrees with itself, that is
 * surfaced rather than smoothed: for Bontang it reports total 143 while its eight status
 * counts sum to 179, because `unplanned` (35) has no rows behind it and `completed`
 * reads 80 against 79 COMPLETED rows.
 */
import { z } from 'zod';
import { dig, walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt, toDateOnly } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, isoDate, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 25;

/**
 * The status values KLIP's filter accepts. Enforced HERE because an unrecognised value
 * is silently ignored upstream - status=BOGUS returned all 143 Bontang rows - so an
 * unchecked string would answer a filtered question with the unfiltered table.
 *
 * These are the filter's buckets, which are coarser than the row's own status. Rows
 * carry ARRIVED_DP and UNLOADING separately; ARRIVED_DP here returns both, because the
 * filter speaks the page's vocabulary ("at discharge port").
 */
const STATUS = ['PLANNED', 'LOADING', 'SAILED', 'ARRIVED_DP', 'COMPLETED', 'CANCELLED'] as const;

/** Statuses that are neither finished nor abandoned - what "open" means on this page. */
const OPEN_ROW_STATUSES = new Set(['PLANNED', 'LOADING', 'SAILED', 'ARRIVED_DP', 'UNLOADING']);

const inputShape = {
  plant: z.string().min(1).optional().describe('Plant or site as klip_reference reports it, e.g. "Bontang".'),
  status: z
    .enum(STATUS)
    .optional()
    .describe('KLIP status bucket. ARRIVED_DP covers both ARRIVED_DP and UNLOADING rows.'),
  sto_number: z.string().min(1).optional().describe('STO number.'),
  vessel_name: z.string().min(1).optional().describe('Vessel name, e.g. "EIHO".'),
  contract_id: z.string().min(1).optional().describe('Contract number, to list that contract\'s shipments.'),
  supplier: z.string().min(1).optional().describe('Supplier name.'),
  product: z.string().min(1).optional().describe('Product, e.g. "CPO" or "PK".'),
  date_from: isoDate.optional().describe('Earliest contract date to include.'),
  date_to: isoDate.optional().describe('Latest contract date to include.'),
  open_only: z
    .boolean()
    .default(false)
    .describe('Keep only shipments still in progress, and sort the most overdue first.'),
  limit: z.number().int().min(1).max(CAP).default(20).describe(`How many shipments to list (max ${CAP}).`),
};

/** Whole days from `iso` to `asOf`; positive means `iso` is in the past. */
function daysPast(iso: string | null, asOf: number): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.floor((asOf - then) / 86_400_000);
}

export const shipmentStatus: ToolDefinition<typeof inputShape> = {
  name: 'klip_shipment_status',
  title: 'KLIP shipment status',
  cap: CAP,
  description: describe(
    'Shipments from the KLIP Shipments page: where each vessel is, and KLIP\'s own Summary Shipment ' +
      'Status counts - unplanned, preplanned, planned, at loading port, sailed, at discharge port, ' +
      'completed, cancelled - with the vessels sitting in each. Filter by plant, status, contract, ' +
      'vessel, STO, supplier, product or contract date. ' +
      'Use this for "shipment status", "where is vessel X", "how many shipments at PLANT" and anything ' +
      'about the delivery window; klip_shipping_performance is the separate Shipping Performance page ' +
      'and reports milestone DELAYS in days, not status. The two report different row sets and must not ' +
      'be mixed. ' +
      'Milestones are a LADDER, not an ETA/ETD pair: arrival at the loading port, berthing, loading ' +
      'complete, sailing, then the discharge side, each with an estimate and an actual. An estimated ' +
      'arrival that precedes an estimated sailing is CORRECT - they are the two ends of the loading ' +
      'call, not a departure and a destination. ' +
      'The status counts are KLIP\'s own and are reported unchanged. Quote them; do not recount them ' +
      'from the listed rows, which are a capped sample.',
    `Returns KLIP's status summary plus up to ${CAP} shipments. Quantities are MT.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.shipments;
    const f = fields.shipment;

    // plant, status, contractId and the date range reach KLIP. sto_number, vessel_name,
    // supplier and product are absent from the route contract by design, so buildFilters
    // puts them in local[] and they are applied below - KLIP would discard them.
    const filterInput = {
      plant: params.plant,
      status: params.status,
      contract_id: params.contract_id,
      sto_number: params.sto_number,
      vessel_name: params.vessel_name,
      supplier: params.supplier,
      product: params.product,
      date_from: params.date_from,
      date_to: params.date_to,
    };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(cache.keyFor('klip_shipment_status', { ...filterInput }), async () =>
      walk<Row>({ route, filters: filters.upstream, maxPages: 3 }),
    );
    const walked = cached.value;

    const matched = walked.rows.filter(
      (row) =>
        matchesLoosely(pickString(row, f.stoNumber), params.sto_number) &&
        matchesLoosely(pickString(row, f.vesselName), params.vessel_name) &&
        matchesLoosely(pickString(row, f.supplier), params.supplier) &&
        matchesLoosely(pickString(row, f.product), params.product),
    );

    const asOf = Date.now();
    const isOpen = (row: Row): boolean =>
      OPEN_ROW_STATUSES.has((pickString(row, f.status) ?? '').toUpperCase());

    const scoped = params.open_only ? matched.filter(isOpen) : matched;
    const ordered = params.open_only
      ? [...scoped].sort(
          (a, b) =>
            (daysPast(toDateOnly(pickString(b, f.deliveryEndDate)), asOf) ?? -1e9) -
            (daysPast(toDateOnly(pickString(a, f.deliveryEndDate)), asOf) ?? -1e9),
        )
      : scoped;

    const shipments = ordered.slice(0, params.limit).map((row) => {
      const deliveryEnd = toDateOnly(pickString(row, f.deliveryEndDate));
      return {
        sto_number: pickString(row, f.stoNumber),
        contract_number: pickString(row, f.contractId),
        vessel_name: pickString(row, f.vesselName),
        status: pickString(row, f.status),
        plant: pickString(row, f.plant),
        supplier: pickString(row, f.supplier),
        product: pickString(row, f.product),
        incoterm: pickString(row, f.incoterm),
        loading_port: pickString(row, f.loadingPort),
        discharge_port: pickString(row, f.dischargePort),
        delivery_start_date: toDateOnly(pickString(row, f.deliveryStartDate)),
        delivery_end_date: deliveryEnd,
        days_past_delivery_end: daysPast(deliveryEnd, asOf),
        // The ladder, named for the milestone each date belongs to.
        eta_loading_arrival: toDateOnly(pickString(row, f.etaLoadArrival)),
        eta_loading_complete: toDateOnly(pickString(row, f.etaLoadComplete)),
        eta_sailed_from_loading: toDateOnly(pickString(row, f.etaSailed)),
        eta_discharge_arrival: toDateOnly(pickString(row, f.etaDischArrival)),
        eta_discharge_complete: toDateOnly(pickString(row, f.etaDischComplete)),
        ata_loading_arrival: toDateOnly(pickString(row, f.ataLoadArrival)),
        ata_loading_complete: toDateOnly(pickString(row, f.ataLoadComplete)),
        ata_sailed_from_loading: toDateOnly(pickString(row, f.ataSailed)),
        ata_discharge_arrival: toDateOnly(pickString(row, f.ataDischArrival)),
        ata_discharge_complete: toDateOnly(pickString(row, f.ataDischComplete)),
        shipped_qty_mt: kgToMt(pickNumber(row, f.qty)),
        contract_qty_mt: kgToMt(pickNumber(row, f.contractQty)),
        sto_qty_mt: kgToMt(pickNumber(row, f.stoQty)),
        outstanding_qty_mt: kgToMt(pickNumber(row, f.outstandingQty)),
      };
    });

    // --- KLIP's own summary, reported rather than recomputed ------------------
    const summary = dig(walked.firstBody, 'data.summary') as
      | { total?: number; status?: Record<string, number>; statusVesselNames?: Record<string, string[]> }
      | undefined;
    const counts = summary?.status;

    const data: Record<string, unknown> = {};

    if (counts !== undefined) {
      const parts = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
      data.klip_status_summary = {
        source: 'KLIP data.summary - the Summary Shipment Status cards on the KLIP Shipments page.',
        total: summary?.total ?? null,
        unplanned: counts.unplanned ?? null,
        preplanned: counts.preplanned ?? null,
        planned: counts.planned ?? null,
        at_loading_port: counts.atLoadingPort ?? null,
        sailed: counts.sailed ?? null,
        at_discharge_port: counts.atDischargePort ?? null,
        completed: counts.completed ?? null,
        cancelled: counts.cancelled ?? null,
        vessels_by_status: summary?.statusVesselNames ?? null,
      };
      // Surfaced, not smoothed. Measured for Bontang: total 143, parts 179.
      if (summary?.total !== undefined && parts !== summary.total) {
        data.klip_summary_reconciliation =
          `KLIP's own status counts sum to ${parts} against its own total of ${summary.total}. Two known ` +
          'causes: `unplanned` has no shipment rows behind it (filtering on UNPLANNED returns none), so ' +
          'it appears to count contract lines awaiting a shipment rather than shipments; and `completed` ' +
          'has read one higher than the COMPLETED row count. Report the individual card figures, which ' +
          'match the page, and do not present the sum as a shipment total. Open with the KLIP team.';
      }
    } else {
      data.klip_status_summary_absent =
        'KLIP returned no data.summary for this query, so no status breakdown is available. Do not ' +
        'substitute a count of the rows below - they are a capped sample.';
    }

    // What the summary actually describes, which is NOT always the filtered set.
    const upstreamApplied = Object.keys(filters.upstream).filter((k) => k !== 'limit' && k !== 'page');
    const upstreamLabel = upstreamApplied.length > 0 ? upstreamApplied.join(', ') : 'none';
    data.summary_scope =
      filters.local.length === 0
        ? `KLIP's summary above covers exactly this query (filters applied upstream: ${upstreamLabel}).`
        : `KLIP's summary above reflects ONLY the filters it applied upstream (${upstreamLabel}). ` +
          `KLIP has no server-side filter for ${filters.local.join(', ')}, so that narrowing was done ` +
          'here, after fetching. The summary therefore describes a WIDER set than the rows listed. Quote ' +
          'the summary only for the upstream filters, and answer the narrower question from the rows.';

    data.shipments = shipments;
    data.rows_shown = shipments.length;
    data.rows_matching_all_filters = scoped.length;

    // --- delivery-window ageing, over every matched row, not the shown sample ---
    const openRows = matched.filter(isOpen);
    const age = (row: Row): number | null => daysPast(toDateOnly(pickString(row, f.deliveryEndDate)), asOf);
    const hasLoadingEta = (row: Row): boolean => pickString(row, f.etaLoadArrival) !== null;
    const hasDischargeEta = (row: Row): boolean => pickString(row, f.etaDischArrival) !== null;
    const hasAnyActual = (row: Row): boolean =>
      pickString(row, f.ataLoadArrival) !== null || pickString(row, f.ataDischArrival) !== null;
    const past7 = openRows.filter((r) => (age(r) ?? -1) >= 7);

    data.delivery_window_ageing = {
      basis: 'delivery_end_date - the Due Date Delivery End column, populated on every row.',
      open_shipments_considered: openRows.length,
      past_delivery_end: openRows.filter((r) => (age(r) ?? -1) > 0).length,
      past_delivery_end_7_days_or_more: past7.length,
      of_those_no_loading_eta: past7.filter((r) => !hasLoadingEta(r)).length,
      of_those_no_discharge_eta: past7.filter((r) => !hasDischargeEta(r)).length,
      of_those_no_estimate_and_no_actual: past7.filter(
        (r) => !hasLoadingEta(r) && !hasDischargeEta(r) && !hasAnyActual(r),
      ).length,
      computed_by:
        'This connector, from KLIP\'s own delivery_end_date and milestone columns. KLIP publishes no ' +
        'equivalent figure, so this competes with nothing - but it is our arithmetic, not a KLIP card. ' +
        'Counted over every row matching the filters, not over the capped list above. Cancelled and ' +
        'completed shipments are excluded.',
    };

    data.milestone_note =
      'Milestones form a ladder with an estimate and an actual at each rung: arrival at the LOADING port, ' +
      'berthing, loading complete, sailing, then arrival, berthing and completion at the discharge port. ' +
      'eta_loading_arrival preceding eta_sailed_from_loading is correct and expected - both belong to the ' +
      'loading call. A null actual means the milestone is unrecorded in KLIP, which is not the same as ' +
      'the event not having happened.';
    data.not_available =
      'sla_days, sfal_qty and sfbd_qty are empty on every row in KLIP staging, and is_delayed is false on ' +
      'every row even where the page marks the shipment Late - so is_delayed is not the page\'s late ' +
      'indicator and is not reported here.';

    if (shipments.length === 0) {
      data.empty_result_note =
        'No shipments matched. Confirm the vessel, plant or STO spelling with klip_reference before ' +
        'reporting that none exist.';
    }

    return {
      data,
      units: 'MT',
      rowCount: shipments.length,
      truncated: walked.truncated,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      coverage: {
        fetched_rows: walked.fetchedRows,
        total_rows: walked.totalRows,
        pages_fetched: walked.pagesFetched,
        total_pages: walked.totalPages,
      },
      klipCalls: walked.calls,
    };
  },
};

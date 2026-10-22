/**
 * klip_shipping_performance - the KLIP Shipping Performance page.
 *
 * Rebuilt 28 Aug 2026 after reading the actual page. The first version had the right
 * endpoint and the wrong shape, which is worse than having neither: it answered
 * confidently in a structure the page does not use.
 *
 * TWO COHORTS, NOT ONE. Verified against the page's own cards:
 *
 *   On Going   status != COMPLETED   107 rows   PLANNED 81, UNLOADING 11,
 *                                               ARRIVED_DP 8, SAILED 5, LOADING 2
 *   Completed  status == COMPLETED   263 rows
 *
 * They use DIFFERENT delta families, which is why the payload carries both. A voyage in
 * flight is measured against estimates; a finished one against actuals. Averaging across
 * the two - which the first version did - mixes a forecast with a record.
 *
 *   On Going   loading_delta_*        discharge_delta_*        total_delta_days
 *   Completed  ata_loading_delta_*    ata_discharge_delta_*    ata_total_delta_days
 *
 * THE PAGE DISCARDS THE SIGN. Its cards read "2 days" where the data holds -2, and most
 * deltas ARE negative - events occurring before estimate. Only the readiness gaps
 * (ETA-ETR +7, ATA-ATR +10) are genuinely positive. We report SIGNED values, because a
 * fleet two days early and a fleet two days late are not the same fleet, and a magnitude
 * cannot tell them apart.
 *
 * COVERAGE IS THIN. Each card rests on 35-45% of its cohort: On Going load readiness on
 * 37 of 107, discharge on 50; Completed load readiness on 117 of 263. Every average
 * ships with its denominator.
 *
 * FILTERS: KLIP applies `plant` only. `scope` here is the PERIOD selector (ytd, mtd,
 * MONTH_01..MONTH_12) - a different meaning from scope on late-performance - and
 * scope=MONTH_06 returned all 370 rows, the same as ytd, so it appears not to filter.
 * Not exposed until that is settled; offering a period control that does nothing would
 * be the exact failure this connector keeps finding.
 *
 * The page footnote claims "transport mode SEA or MIX only". The endpoint returns 6 LAND
 * rows among the 370, so that claim is not true of the data.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt, toDateOnly } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 25;

const inputShape = {
  plant: z.string().min(1).optional().describe('Plant or site as klip_reference reports it, e.g. "Bontang".'),
  vessel_name: z.string().min(1).optional().describe('Vessel or barge name, e.g. "MT. GIAT ARMADA 02".'),
  product: z.string().min(1).optional().describe('Product name, e.g. "CPO" or "PK".'),
  supplier: z.string().min(1).optional().describe('Supplier name.'),
  contract_number: z.string().min(1).optional().describe('Contract, PO or STO number.'),
  cohort: z
    .enum(['on_going', 'completed', 'both'])
    .default('both')
    .describe('On-going voyages are measured against ESTIMATES, completed ones against ACTUALS.'),
  limit: z.number().int().min(1).max(CAP).default(15).describe(`How many shipments to return (max ${CAP}).`),
  rank_by: z
    .enum(['none', 'total_days', 'outstanding'])
    .default('none')
    .describe('Order the shipments before the limit is applied: "total_days" = longest total duration first, "outstanding" = most outstanding first, "none" = KLIP order. Ranking covers every shipment fetched, not just the first page.'),
};

/** Signed mean with its denominator. Never a mean over absent values. */
function avg(rows: readonly Row[], candidates: readonly string[]): { days: number | null; measured_on: number } {
  const present = rows
    .map((r) => pickNumber(r, candidates))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return { days: null, measured_on: 0 };
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return { days: Math.round(mean * 10) / 10, measured_on: present.length };
}

function mapRow(row: Row, f: typeof fields.shippingPerformance): Record<string, unknown> {
  const completed = (pickString(row, f.status) ?? '').toUpperCase() === 'COMPLETED';
  return {
    vessel_name: pickString(row, f.vesselName),
    sto_number: pickString(row, f.stoNumber),
    contract_number: pickString(row, f.contractNumber),
    supplier: pickString(row, f.supplier),
    product: pickString(row, f.product),
    incoterm: pickString(row, f.incoterm),
    status: pickString(row, f.status),
    cohort: completed ? 'completed' : 'on_going',
    loading_port: pickString(row, f.loadingPort),
    discharge_port: pickString(row, f.dischargePort),
    plant: pickString(row, f.plant),
    group_plant: pickString(row, f.groupName),
    charter_type: pickString(row, f.charterType),
    source_type: pickString(row, f.sourceType),
    transport_mode: pickString(row, f.transportMode),
    contract_qty_mt: kgToMt(pickNumber(row, f.contractQty)),
    sto_qty_mt: kgToMt(pickNumber(row, f.stoQty)),
    delivered_qty_mt: kgToMt(pickNumber(row, f.deliveredQty)),
    received_qty_mt: kgToMt(pickNumber(row, f.receivedQty)),
    outstanding_qty_mt: kgToMt(pickNumber(row, f.outstandingQty)),
    // The gap between what was delivered and what was received on this voyage. Mapped
    // and never emitted, which left this tool reporting how LATE a shipment was while
    // silently holding how much of it failed to arrive.
    shortage_mt: kgToMt(pickNumber(row, f.shortage)),
    /**
     * FOUR OPERATIONAL METRICS, mapped since this tool was written and never emitted.
     * They are the causes behind the deltas below: a slow pump rate explains a long
     * berth-to-complete, a low sailing speed explains a late arrival, and freight and
     * fuel are what the delay costs. Reporting the delay without them gives the symptom
     * and withholds the diagnosis - and this is the page people open to ask WHY.
     *
     * KLIP's own figures. Units are not stated on the endpoint, so none is asserted
     * here; the field names carry what KLIP calls them.
     */
    pump_rate: pickNumber(row, f.pumpRate),
    sailing_speed: pickNumber(row, f.sailingSpeed),
    freight: pickNumber(row, f.freight),
    fuel_consumption: pickNumber(row, f.fuelConsumption),
    cargo_readiness_date: toDateOnly(pickString(row, f.cargoReadiness)),
    // The delta family that applies to THIS row's cohort: KLIP's milestone differences,
    // i.e. durations (see sign_note), reported as KLIP holds them.
    load_readiness_days: pickNumber(row, completed ? f.ataLoadDeltaToReadiness : f.loadDeltaToReadiness),
    load_arrival_to_berth_days: pickNumber(row, completed ? f.ataLoadDeltaArrivalToBerth : f.loadDeltaArrivalToBerth),
    load_berth_to_complete_days: pickNumber(row, completed ? f.ataLoadDeltaBerthToComplete : f.loadDeltaBerthToComplete),
    discharge_arrival_to_berth_days: pickNumber(row, completed ? f.ataDischDeltaArrivalToBerth : f.dischDeltaArrivalToBerth),
    discharge_berth_to_complete_days: pickNumber(row, completed ? f.ataDischDeltaBerthToComplete : f.dischDeltaBerthToComplete),
    total_days: pickNumber(row, completed ? f.ataTotalDeltaDays : f.totalDeltaDays),
  };
}

export const shippingPerformance: ToolDefinition<typeof inputShape> = {
  name: 'klip_shipping_performance',
  title: 'KLIP shipping performance',
  cap: CAP,
  description: describe(
    'Vessel and barge performance from the KLIP Shipping Performance page, split the way that page ' +
      'splits it: ON GOING voyages measured against estimated times, COMPLETED voyages against actual ' +
      'times. Reports average days for loading readiness, arrival-to-berth, berth-to-complete and the ' +
      'discharge equivalents, plus the shipments behind them - vessel, STO, ports, supplier, product, ' +
      'quantities and status. Filter by plant, vessel, product, supplier or contract. ' +
      'Use this for SHIPPING and vessel questions; klip_performance_summary is contract delivery ' +
      'lateness and knows nothing about voyages. ' +
      'The day figures are DURATIONS between milestones (arrival to berth, berth to complete, at the loading ' +
      'and discharge ports; the total is their sum), not lateness against a plan. KLIP subtracts the later ' +
      'milestone from the earlier, so port segments are usually negative; the page shows the size without ' +
      'the sign. Use rank_by to get the longest voyages or the most outstanding across every shipment fetched. ' +
      'Contracts with no shipment at all are not voyages and are left out (see klip_unassigned_outstanding). ' +
      'Roughly a third to a half of shipments carry each measurement, so every average is reported with ' +
      'the count behind it and must be quoted with that count.',
    `Returns at most ${CAP} shipments plus per-cohort averages. This endpoint has no pagination and ` +
      'reports no total, so completeness cannot be asserted.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.shippingPerformance;
    const limit = Math.min(params.limit, CAP);
    const f = fields.shippingPerformance;

    // Only plant reaches KLIP. Everything else is discarded upstream, so it is applied here.
    const filters = buildFilters(route, { plant: params.plant });

    const cached = await cache.through(
      cache.keyFor('klip_shipping_performance', { plant: params.plant }),
      async () => walk<Row>({ route, filters: filters.upstream, maxPages: 1 }),
    );
    const walked = cached.value;

    const matched = walked.rows.filter(
      (row) =>
        matchesLoosely(pickString(row, f.vesselName), params.vessel_name) &&
        matchesLoosely(pickString(row, f.product), params.product) &&
        matchesLoosely(pickString(row, f.supplier), params.supplier) &&
        (params.contract_number === undefined ||
          matchesLoosely(pickString(row, f.contractNumber), params.contract_number) ||
          matchesLoosely(pickString(row, f.poNumber), params.contract_number) ||
          matchesLoosely(pickString(row, f.stoNumber), params.contract_number)),
    );

    const isDone = (r: Row): boolean => (pickString(r, f.status) ?? '').toUpperCase() === 'COMPLETED';
    // KLIP appends one row per contract with NO shipment (status UNPLANNED, no vessel) to this
    // endpoint's data. They are not voyages: KLIP's own averages leave them out, and counting
    // them made "on going" include contracts nothing had been booked for.
    const isBacklog = (r: Row): boolean =>
      (pickString(r, f.status) ?? '').toUpperCase() === 'UNPLANNED' && (pickString(r, f.vesselName) ?? '').trim() === '';
    const backlogExcluded = matched.filter(isBacklog).length;
    const voyages = matched.filter((r) => !isBacklog(r));
    const going = voyages.filter((r) => !isDone(r));
    const done = voyages.filter(isDone);

    const cohortStats = (rows: readonly Row[], actual: boolean): Record<string, unknown> => ({
      shipments: rows.length,
      distinct_vessels: new Set(rows.map((r) => pickString(r, f.vesselName)).filter(Boolean)).size,
      basis: actual ? 'actual times (ATA)' : 'estimated times (ETA)',
      load_readiness: avg(rows, actual ? f.ataLoadDeltaToReadiness : f.loadDeltaToReadiness),
      load_arrival_to_berth: avg(rows, actual ? f.ataLoadDeltaArrivalToBerth : f.loadDeltaArrivalToBerth),
      load_berth_to_complete: avg(rows, actual ? f.ataLoadDeltaBerthToComplete : f.loadDeltaBerthToComplete),
      discharge_arrival_to_berth: avg(rows, actual ? f.ataDischDeltaArrivalToBerth : f.dischDeltaArrivalToBerth),
      discharge_berth_to_complete: avg(rows, actual ? f.ataDischDeltaBerthToComplete : f.dischDeltaBerthToComplete),
      total: avg(rows, actual ? f.ataTotalDeltaDays : f.totalDeltaDays),
    });

    const wanted =
      params.cohort === 'on_going' ? going : params.cohort === 'completed' ? done : voyages;
    // Ranking happens BEFORE the limit, over every shipment fetched - otherwise a "top 3"
    // is only the top of whatever KLIP happened to return first.
    const totalOf = (r: Row): number => Math.abs(pickNumber(r, isDone(r) ? f.ataTotalDeltaDays : f.totalDeltaDays) ?? -1);
    const ordered =
      params.rank_by === 'total_days' ? [...wanted].sort((a, b) => totalOf(b) - totalOf(a))
      : params.rank_by === 'outstanding' ? [...wanted].sort((a, b) => (pickNumber(b, f.outstandingQty) ?? -1) - (pickNumber(a, f.outstandingQty) ?? -1))
      : wanted;
    const shipments = ordered.slice(0, limit).map((r) => mapRow(r, f));

    const data: Record<string, unknown> = {
      on_going: cohortStats(going, false),
      completed: cohortStats(done, true),
      // Corrected 21 Oct 2026 from the KLIP source (shippingPerformance.service.ts, deltas via
      // diffCalendarDays): each figure is one milestone date minus another, e.g.
      // load_eta_arrival - load_eta_berthed. The earlier note read the sign as early/late.
      sign_note:
        'These are DURATIONS between milestones, not lateness against a plan. KLIP subtracts the later ' +
        'milestone from the earlier one for each port segment (arrival to berth, berth to complete), so ' +
        'those values are usually negative and their size is the length of the interval in days; ' +
        'load_readiness is arrival minus cargo readiness. The KLIP page shows the size without the sign, ' +
        'and its total is the sum of the five segments. Never describe a negative figure as early or a ' +
        'positive one as late: KLIP measures lateness separately, against the delivery end date.',
      coverage_note:
        'Each average covers only shipments carrying that measurement - see measured_on beside every ' +
        'figure, typically a third to a half of the cohort. A shipment without a measurement is ' +
        'UNMEASURED, not on time.',
      computed_by:
        'The per-shipment day figures are KLIP\'s own, taken from its delta columns. This connector ' +
        'groups them into the two cohorts the page uses and averages them; it does not recompute a ' +
        'delta from the timestamps.',
      shipments,
      rows_shown: shipments.length,
      ranked_by: params.rank_by === 'total_days' ? 'longest total duration first (size of total_days), over every shipment fetched'
        : params.rank_by === 'outstanding' ? 'most outstanding first, over every shipment fetched' : 'KLIP order',
      contracts_without_shipment_excluded: backlogExcluded,
      not_available:
        'Freight, fuel consumption, pump rate and sailing speed are empty for every shipment in KLIP ' +
        'staging, and shortage for all but a handful. The page has columns for them; there is no data ' +
        'behind them, so they are omitted rather than reported as zero.',
      filters_applied_locally:
        'KLIP applies the plant filter only. Vessel, product, supplier and contract number are accepted ' +
        'by the endpoint and discarded, so this connector applies them after fetching. There is also no ' +
        'working period filter: the page offers YTD, MTD and months, but the endpoint returned the same ' +
        '370 rows for a month as for the year, so no period control is offered here.',
    };

    if (shipments.length === 0) {
      data.empty_result_note =
        'No shipments matched. Confirm the vessel or plant spelling with klip_reference before reporting ' +
        'that none exist.';
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
        // KLIP reports no total here, so completeness is unknown rather than equal to
        // what we happened to read.
        total_rows: null,
        pages_fetched: walked.pagesFetched,
        total_pages: null,
      },
      klipCalls: walked.calls,
    };
  },
};

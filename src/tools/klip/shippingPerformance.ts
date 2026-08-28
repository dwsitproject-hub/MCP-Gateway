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
    transport_mode: pickString(row, f.transportMode),
    contract_qty_mt: kgToMt(pickNumber(row, f.contractQty)),
    outstanding_qty_mt: kgToMt(pickNumber(row, f.outstandingQty)),
    cargo_readiness_date: toDateOnly(pickString(row, f.cargoReadiness)),
    // The delta family that applies to THIS row's cohort. Signed: negative means the
    // event happened before the estimate.
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
      'FIGURES ARE SIGNED: a negative average means the event happened BEFORE the estimate. The KLIP ' +
      'page shows the magnitude only, so a number here may appear with the opposite sense to the page - ' +
      'that is deliberate, because early and late are not the same result. ' +
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
    const going = matched.filter((r) => !isDone(r));
    const done = matched.filter(isDone);

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
      params.cohort === 'on_going' ? going : params.cohort === 'completed' ? done : matched;
    const shipments = wanted.slice(0, limit).map((r) => mapRow(r, f));

    const data: Record<string, unknown> = {
      on_going: cohortStats(going, false),
      completed: cohortStats(done, true),
      sign_note:
        'Averages are SIGNED. Negative means the event happened before the estimate; positive means ' +
        'after. The KLIP Shipping Performance page displays magnitudes only, so its cards show a ' +
        'positive number where these show a negative one. Do not describe a negative figure as a delay.',
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

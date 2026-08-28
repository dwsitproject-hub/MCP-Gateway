/**
 * klip_shipping_performance - "how are the Bontang vessels running against plan?"
 *
 * Backs the KLIP Shipping Performance page: planned against actual at every port
 * milestone, per shipment.
 *
 * KLIP COMPUTES THE DELAYS. total_delta_days, the loading and discharge deltas and the
 * ata_* variants are its arithmetic over the ETA/ATA pairs. We report those and do not
 * subtract timestamps ourselves, for the reason klip_outstanding stopped computing
 * outstanding: a second calculation is a second answer.
 *
 * COVERAGE IS THE STORY HERE, not the average.
 *
 * On staging, 137 of 370 shipments carry total_delta_days and only 90 carry a completed
 * discharge. A mean over those is a mean over a third of the fleet, and quoting it as
 * fleet performance would be the same error as summing a page of contracts and calling
 * it a total. So every metric ships with the count behind it, and the payload says
 * plainly what is missing.
 *
 * FILTERS: KLIP applies `plant` only. vessel_name, status and contract_number are
 * accepted and DISCARDED - each returns all 370 rows - so those are filtered here and
 * the payload says so.
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
  vessel_name: z.string().min(1).optional().describe('Vessel or barge name, e.g. "BG. ELANG JAWA 1".'),
  status: z.string().min(1).optional().describe('Shipment status, e.g. PLANNED, SAILED, COMPLETED.'),
  product: z.string().min(1).optional().describe('Product name, e.g. "CPO" or "PK".'),
  supplier: z.string().min(1).optional().describe('Supplier name.'),
  contract_number: z.string().min(1).optional().describe('Contract, PO or STO number.'),
  limit: z.number().int().min(1).max(CAP).default(15).describe(`How many shipments to return (max ${CAP}).`),
};

/** Mean of the present values, with the count it rests on. Never a mean over nulls. */
function meanOf(values: ReadonlyArray<number | null>): { mean: number | null; of: number } {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return { mean: null, of: 0 };
  const sum = present.reduce((a, b) => a + b, 0);
  return { mean: Math.round((sum / present.length) * 10) / 10, of: present.length };
}

function mapRow(row: Row): Record<string, unknown> {
  const f = fields.shippingPerformance;
  return {
    shipment_id: pickString(row, f.shipmentId),
    sto_number: pickString(row, f.stoNumber),
    contract_number: pickString(row, f.contractNumber),
    po_number: pickString(row, f.poNumber),
    supplier: pickString(row, f.supplier),
    product: pickString(row, f.product),
    plant: pickString(row, f.plant),
    vessel_name: pickString(row, f.vesselName),
    charter_type: pickString(row, f.charterType),
    transport_mode: pickString(row, f.transportMode),
    status: pickString(row, f.status),
    loading_port: pickString(row, f.loadingPort),
    discharge_port: pickString(row, f.dischargePort),
    cargo_readiness_date: toDateOnly(pickString(row, f.cargoReadiness)),
    contract_qty_mt: kgToMt(pickNumber(row, f.contractQty)),
    sto_qty_mt: kgToMt(pickNumber(row, f.stoQty)),
    // Planned against actual, both ends. Nulls are left as nulls: an absent milestone is
    // not an on-time one.
    loading_eta_arrival: toDateOnly(pickString(row, f.loadEtaArrival)),
    loading_ata_arrival: toDateOnly(pickString(row, f.loadAtaArrival)),
    loading_eta_sailed: toDateOnly(pickString(row, f.loadEtaSailed)),
    loading_ata_sailed: toDateOnly(pickString(row, f.loadAtaSailed)),
    discharge_eta_completed: toDateOnly(pickString(row, f.dischEtaCompleted)),
    discharge_ata_completed: toDateOnly(pickString(row, f.dischAtaCompleted)),
    // KLIP's own delay figures. Positive is late.
    total_delta_days: pickNumber(row, f.totalDeltaDays),
    loading_delay_days: pickNumber(row, f.loadDeltaArrivalToBerth),
    discharge_delay_days: pickNumber(row, f.dischDeltaArrivalToBerth),
  };
}

export const shippingPerformance: ToolDefinition<typeof inputShape> = {
  name: 'klip_shipping_performance',
  title: 'KLIP shipping performance',
  cap: CAP,
  description: describe(
    'Vessel and barge performance against plan, from the KLIP Shipping Performance page: estimated ' +
      'against actual arrival, berthing, loading, sailing and discharge per shipment, with the delay in ' +
      'days that KLIP computes from them. Filter by plant, vessel, status, product, supplier or contract. ' +
      'Use this for questions about SHIPPING and vessels - how a barge ran against schedule, which ' +
      'voyages are late, discharge turnaround. It is NOT the same as klip_performance_summary, which is ' +
      'about contract delivery lateness and knows nothing about vessels. ' +
      'MOST SHIPMENTS HAVE NO DELAY FIGURE: on current data roughly a third carry one, so every average ' +
      'is reported with the number of shipments behind it and must be quoted with that count, never as ' +
      'fleet-wide performance.',
    `Returns at most ${CAP} shipments plus KLIP-computed delay averages over those that have one. ` +
      'This endpoint has no pagination and reports no total, so completeness cannot be asserted.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.shippingPerformance;
    const limit = Math.min(params.limit, CAP);
    const f = fields.shippingPerformance;

    // Only plant reaches KLIP; everything else is discarded upstream, so it is applied here.
    const filters = buildFilters(route, { plant: params.plant });

    const cached = await cache.through(
      cache.keyFor('klip_shipping_performance', { plant: params.plant }),
      async () => walk<Row>({ route, filters: filters.upstream, maxPages: 1 }),
    );
    const walked = cached.value;

    const matched = walked.rows.filter(
      (row) =>
        matchesLoosely(pickString(row, f.vesselName), params.vessel_name) &&
        matchesLoosely(pickString(row, f.status), params.status) &&
        matchesLoosely(pickString(row, f.product), params.product) &&
        matchesLoosely(pickString(row, f.supplier), params.supplier) &&
        (params.contract_number === undefined ||
          matchesLoosely(pickString(row, f.contractNumber), params.contract_number) ||
          matchesLoosely(pickString(row, f.poNumber), params.contract_number) ||
          matchesLoosely(pickString(row, f.stoNumber), params.contract_number)),
    );

    const totalDelta = meanOf(matched.map((r) => pickNumber(r, f.totalDeltaDays)));
    const loadDelta = meanOf(matched.map((r) => pickNumber(r, f.loadDeltaArrivalToBerth)));
    const dischDelta = meanOf(matched.map((r) => pickNumber(r, f.dischDeltaArrivalToBerth)));
    const withDischarge = matched.filter((r) => pickString(r, f.dischAtaCompleted) !== null).length;

    const rows = matched.slice(0, limit).map(mapRow);

    const data: Record<string, unknown> = {
      delay_days: {
        total: totalDelta.mean,
        total_measured_on: totalDelta.of,
        loading_arrival_to_berth: loadDelta.mean,
        loading_measured_on: loadDelta.of,
        discharge_arrival_to_berth: dischDelta.mean,
        discharge_measured_on: dischDelta.of,
        shipments_matched: matched.length,
      },
      coverage_note:
        `Delay figures come from KLIP and cover only shipments that have one: ${totalDelta.of} of ` +
        `${matched.length} matched shipments carry a total delay, and ${withDischarge} have a completed ` +
        'discharge. Quote any average together with the count behind it. A shipment with no delay figure ' +
        'is unmeasured, NOT on time.',
      computed_by:
        'KLIP. The delay columns are its own arithmetic over the estimated and actual timestamps; this ' +
        'connector reports them and does not recompute them.',
      shipments: rows,
      rows_shown: rows.length,
      not_available:
        'freight, fuel consumption, pump rate and sailing speed are empty for every shipment in KLIP ' +
        'staging, and shortage for all but a handful. The Shipping Performance page has columns for ' +
        'them; there is no data behind them, so they are not reported here rather than reported as zero.',
      filters_applied_locally:
        'KLIP applies the plant filter only. Vessel, status, product, supplier and contract number are ' +
        'accepted by the endpoint and discarded, so this connector applies them after fetching. A filter ' +
        'matching nothing means nothing matched in the rows retrieved.',
    };

    if (rows.length === 0) {
      data.empty_result_note =
        'No shipments matched. Confirm the vessel or plant spelling with klip_reference before reporting ' +
        'that none exist.';
    }

    return {
      data,
      units: 'MT',
      rowCount: rows.length,
      truncated: walked.truncated,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      coverage: {
        fetched_rows: walked.fetchedRows,
        // KLIP reports no total on this endpoint, so completeness is unknown rather than
        // equal to what we read.
        total_rows: null,
        pages_fetched: walked.pagesFetched,
        total_pages: null,
      },
      klipCalls: walked.calls,
    };
  },
};

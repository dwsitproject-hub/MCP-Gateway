/**
 * klip_oil_loss - "how much did we lose in transit on the Cisadane runs last month?"
 *
 * Weight reconciliation between dispatch and receipt. NOT quality: KLIP has no REST
 * endpoint over quality_surveys at all (confirmed 27 Aug 2026), and oil loss is a
 * different measurement that happens to sit near it in the KLIP UI. Keeping them apart
 * is the same argument we made against mapping a dispatched weight onto "sent".
 *
 * Three things about this endpoint make it unlike every other route here.
 *
 * NO PAGINATION. The envelope is { data, ytdSummary, gainSummary, dataSources } with no
 * success wrapper, no page, no limit, no total. Whether the server caps the row set is
 * unmeasured, so this tool cannot claim completeness and says so rather than implying it.
 *
 * UNITS ARE UNCONFIRMED at row level. The payload mixes them and labels only some:
 * gainSummary.totalGainKg is kilograms, ytdSummary.r1.totalMt is tonnes, and the
 * row-level quantity_* fields carry no suffix either way. Nothing is converted on a
 * guess - being wrong here is a 1000x error, and the KLIP team have been asked.
 *
 * THE ENDPOINT RETURNS LOSS ROWS ONLY. Confirmed by the KLIP team on 28 Aug 2026: the
 * query ends `AND qty_receive_resolved < qty_delivery_resolved`. So the rows are
 * movements that LOST oil, not all movements, and any rate built on them has a
 * loss-population denominator. This is stated in every response, because "3,305
 * movements" reads as the fleet unless something says otherwise.
 *
 * quantity_sent IS PRESENT here and was withheld pending confirmation, on the grounds
 * that KLIP had not declared its provenance. Confirmed 28 Aug 2026, and the reason is
 * worse than an undeclared field - oilLossQuerySql.ts emits the same expression twice:
 *
 *   qty_delivery_resolved AS quantity_delivery   -- line 292
 *   qty_receive_resolved  AS quantity_received   -- line 293
 *   qty_delivery_resolved AS quantity_sent       -- line 294
 *
 * It is a legacy alias, not a measurement. Surfacing it would have reported the
 * delivered quantity a second time under a name meaning something else, and it would
 * have looked right - fully populated and correctly scaled. It stays unsurfaced, now
 * for a settled reason rather than a pending one. KLIP-004 stands: sent weight does not
 * exist in the pipeline.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { toDateOnly } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 50;

const inputShape = {
  contract_number: z.string().min(1).optional().describe('Contract number, PO number or STO number.'),
  plant: z.string().min(1).optional().describe('Plant or site name as klip_reference reports it.'),
  product: z.string().min(1).optional().describe('Product name, e.g. "CPO".'),
  transport_mode: z.string().min(1).optional().describe('Transport mode, e.g. "LAND" or "SEA".'),
  limit: z.number().int().min(1).max(CAP).default(20).describe(`How many rows to return (max ${CAP}).`),
};

function mapRow(row: Row): Record<string, unknown> {
  const f = fields.oilLoss;
  return {
    operation_id: pickString(row, f.operationId),
    contract_number: pickString(row, f.contractNumber),
    sto_number: pickString(row, f.stoNumber),
    po_number: pickString(row, f.poNumber),
    supplier: pickString(row, f.supplier),
    product: pickString(row, f.product),
    plant: pickString(row, f.plant),
    transport_mode: pickString(row, f.transportMode),
    transporter: pickString(row, f.transporter),
    loading_location: pickString(row, f.loadingLocation),
    unloading_location: pickString(row, f.unloadingLocation),
    operation_date: toDateOnly(pickString(row, f.operationDate)),
    status: pickString(row, f.status),
    // Reported exactly as KLIP holds them. See the unit note in the header: no
    // conversion is applied because the row-level unit is not established.
    quantity_dispatched: pickNumber(row, f.dispatched),
    quantity_received: pickNumber(row, f.received),
    gain_loss: pickNumber(row, f.gainLossAmount),
    gain_loss_percentage: pickNumber(row, f.gainLossPercentage),
  };
}

export const oilLoss: ToolDefinition<typeof inputShape> = {
  name: 'klip_oil_loss',
  title: 'KLIP oil loss and gain',
  cap: CAP,
  description: describe(
    'Oil loss or gain in transit: dispatched weight against received weight per movement, with the ' +
      'gain/loss KLIP computes from them, filterable by contract, plant, product or transport mode. ' +
      'Use this for questions like "how much did we lose on the Cisadane runs?". ' +
      'This is WEIGHT RECONCILIATION, not laboratory quality - FFA, M&I, IV and DOBI are not ' +
      'available through this connector at all. ' +
      'QUANTITIES ARE UNCONVERTED: the unit of the row-level figures is not yet confirmed with the ' +
      'KLIP team, so report them as KLIP states them and do not describe them as tonnes or kilograms.',
    `Returns at most ${CAP} rows. KLIP does not paginate this endpoint, so the row set may be capped ` +
      'server-side by an amount this connector cannot see.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.oilLoss;
    const limit = Math.min(params.limit, CAP);

    const cached = await cache.through(cache.keyFor('klip_oil_loss', {}), async () =>
      // Every filter is applied locally: no query parameters are advertised on this
      // endpoint, and sending unknown ones to KLIP is how a filter silently does nothing.
      walk<Row>({ route, filters: {}, maxPages: 1 }),
    );
    const walked = cached.value;

    const f = fields.oilLoss;
    const matched = walked.rows.filter(
      (row) =>
        matchesLoosely(pickString(row, f.contractNumber), params.contract_number) &&
        matchesLoosely(pickString(row, f.plant), params.plant) &&
        matchesLoosely(pickString(row, f.product), params.product) &&
        matchesLoosely(pickString(row, f.transportMode), params.transport_mode),
    );

    const rows = matched.slice(0, limit).map(mapRow);

    const data: Record<string, unknown> = {
      movements: rows,
      rows_shown: rows.length,
      matching_rows: matched.length,
      units_note:
        'Quantities and gain/loss are reported exactly as KLIP returns them. The unit of the ' +
        'row-level figures is NOT confirmed - KLIP mixes kilograms and tonnes on this endpoint and ' +
        'labels only some of them. Do not convert these figures or describe them as MT.',
      population_note:
        'THESE ARE LOSS MOVEMENTS ONLY. KLIP filters this endpoint to rows where the received quantity ' +
        'is less than the delivered quantity, so it returns movements that lost oil - never the full ' +
        'set of movements. Any rate computed from these rows has a loss-population denominator: it can ' +
        'answer "how large were the losses" but never "what share of movements lost oil". Confirmed by ' +
        'the KLIP team, 28 Aug 2026.',
      coverage_note:
        'Within that loss population the set is complete: KLIP applies no cap, no pagination and reads ' +
        'no query parameters on this endpoint - its controller signature takes no request - so what is ' +
        'returned is every loss row. It reports no total, which is why total_rows is null.',
      filters_applied_locally:
        'Filters were applied by this connector after fetching, because KLIP advertises no query ' +
        'parameters here. A filter matching nothing means nothing matched in the rows retrieved.',
    };

    if (rows.length === 0) {
      data.empty_result_note =
        'No movements matched. Confirm the contract number or plant with klip_reference before ' +
        'reporting that no loss was recorded.';
    }

    return {
      data,
      // Deliberately null rather than 'MT': claiming a unit we have not established is
      // exactly the error this connector keeps finding elsewhere.
      units: null,
      rowCount: rows.length,
      // No total is available, so coverage cannot be asserted either way. Reporting
      // truncated:false here would imply completeness we cannot see.
      truncated: walked.truncated,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      coverage: {
        fetched_rows: walked.fetchedRows,
        total_rows: null,
        pages_fetched: walked.pagesFetched,
        total_pages: null,
      },
      klipCalls: walked.calls,
    };
  },
};

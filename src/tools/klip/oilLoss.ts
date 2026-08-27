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
 * quantity_sent IS PRESENT here, which contradicts KLIP-004's finding that sent weight
 * exists nowhere. It is deliberately not surfaced until KLIP confirms whether it is a
 * real weighbridge-out figure and how many rows carry it. Reporting a weight on the
 * strength of one row would repeat the mistake we objected to.
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
      coverage_note:
        'KLIP does not paginate this endpoint and reports no total, so this connector cannot tell ' +
        'whether every movement was returned. Treat the set as possibly incomplete.',
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

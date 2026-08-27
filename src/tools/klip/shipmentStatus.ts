/**
 * klip_shipment_status - "Where is vessel X?"
 *
 * At least one identifying filter is required: an unfiltered vessel query would
 * return the whole shipment table, which is neither useful nor bounded.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt, toWibIso } from './../../adapters/klip/normalize.js';
import { invalidParams } from './../../core/errors.js';
import * as cache from './../../core/cache.js';
import { buildFilters, isoDate, localFilterNote, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 20;

const inputShape = {
  sto_number: z.string().min(1).optional().describe('STO number.'),
  vessel_name: z.string().min(1).optional().describe('Vessel name.'),
  contract_id: z.string().min(1).optional().describe('Contract id, to list that contract\'s shipments.'),
  date_from: isoDate.optional().describe('Earliest shipment date to include.'),
  date_to: isoDate.optional().describe('Latest shipment date to include.'),
};

export const shipmentStatus: ToolDefinition<typeof inputShape> = {
  name: 'klip_shipment_status',
  title: 'KLIP shipment status',
  cap: CAP,
  description: describe(
    'Vessel and STO milestones: status, loading and discharge ports, ETD/ETA and ATD/ATA, and shipped quantity. ' +
      'At least one of sto_number, vessel_name or contract_id is required.',
    `Returns at most ${CAP} shipments.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (params.sto_number === undefined && params.vessel_name === undefined && params.contract_id === undefined) {
      throw invalidParams('Provide at least one of sto_number, vessel_name or contract_id.', {
        required_one_of: ['sto_number', 'vessel_name', 'contract_id'],
      });
    }

    const route = routes.shipments;
    const filterInput = {
      sto_number: params.sto_number,
      vessel_name: params.vessel_name,
      contract_id: params.contract_id,
      date_from: params.date_from,
      date_to: params.date_to,
    };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(cache.keyFor('klip_shipment_status', { ...filterInput }), async () =>
      walk<Row>({ route, filters: filters.upstream, maxPages: 3 }),
    );
    const walked = cached.value;

    let rows = walked.rows;
    if (filters.local.length > 0) {
      rows = rows.filter(
        (row) =>
          (!filters.local.includes('sto_number') ||
            matchesLoosely(pickString(row, fields.shipment.stoNumber), params.sto_number)) &&
          (!filters.local.includes('vessel_name') ||
            matchesLoosely(pickString(row, fields.shipment.vesselName), params.vessel_name)) &&
          (!filters.local.includes('contract_id') ||
            matchesLoosely(pickString(row, fields.shipment.contractId), params.contract_id)),
      );
    }

    const shipments = rows.slice(0, CAP).map((row) => ({
      sto_number: pickString(row, fields.shipment.stoNumber),
      contract_id: pickString(row, fields.shipment.contractId),
      vessel_name: pickString(row, fields.shipment.vesselName),
      status: pickString(row, fields.shipment.status),
      loading_port: pickString(row, fields.shipment.loadingPort),
      discharge_port: pickString(row, fields.shipment.dischargePort),
      etd: toWibIso(pickString(row, fields.shipment.etd)),
      eta: toWibIso(pickString(row, fields.shipment.eta)),
      atd: toWibIso(pickString(row, fields.shipment.atd)),
      ata: toWibIso(pickString(row, fields.shipment.ata)),
      qty_mt: kgToMt(pickNumber(row, fields.shipment.qty)),
    }));

    const data: Record<string, unknown> = {
      shipments,
      matching_shipments: rows.length,
      milestone_note:
        'ETD/ETA are estimates and ATD/ATA are actuals. A null actual means the milestone has not been recorded ' +
        'in KLIP, which is not the same as the event not having happened.',
    };
    // truncated now reports COVERAGE only, so the display bound has to be stated here
    // or the caller cannot tell a shortened list from a complete one.
    data.rows_shown = shipments.length;
    data.matching_rows = walked.fetchedRows;
    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;
    if (shipments.length === 0) {
      data.empty_result_note =
        'No shipments matched. Check the vessel or STO spelling before reporting that none exist.';
    }

    return {
      data,
      units: 'MT',
      rowCount: shipments.length,
      // TRUNCATED MEANS COVERAGE, NOT DISPLAY (review KLIP-008).
      // This used to also fire when more rows were FETCHED than shown, which is a
      // different fact: the aggregates are then complete and only the row list is
      // shortened. Reporting that as truncated attached "the figures cover only part
      // of the matching data" to results with 235 of 235 rows - and a warning that
      // cries wolf on complete results is one people stop reading on partial ones.
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

/**
 * klip_quality_surveys - "DOBI at discharge for STO Z?"
 *
 * CURRENTLY UNAVAILABLE. Confirmed by the KLIP team on 27 Aug 2026: no /api/quality*
 * route exists and there is no REST handler over quality_surveys anywhere in KLIP.
 * The data is reachable only through the pages that render it.
 *
 * The tool refuses rather than returning nothing. Walking a route that 404s produced an
 * empty row set, which this tool then reported as "no surveys matched" - telling the
 * user no survey exists for their shipment when the truth is that the connector cannot
 * see any survey at all. An absent endpoint is not an empty result, and the difference
 * matters most to whoever is trying to find out whether a cargo was tested.
 *
 * The mapping below is kept intact so the tool can be restored by pointing the route at
 * a real path once KLIP ships one.
 *
 * Quality measurements are NOT quantities: FFA, M&I, IV and DOBI pass through
 * unconverted. Running them through kgToMt would be the classic unit accident.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { toDateOnly } from './../../adapters/klip/normalize.js';
import { invalidParams, capabilityUnavailable } from './../../core/errors.js';
import * as cache from './../../core/cache.js';
import { buildFilters, localFilterNote, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 20;

const inputShape = {
  shipment_id: z.string().min(1).optional().describe('Shipment id or STO number.'),
  contract_id: z.string().min(1).optional().describe('Contract id.'),
  location: z
    .string()
    .min(1)
    .optional()
    .describe('Survey point, e.g. "discharge" or "loading", as klip_reference-style values appear in KLIP.'),
};

export const qualitySurveys: ToolDefinition<typeof inputShape> = {
  name: 'klip_quality_surveys',
  title: 'KLIP quality surveys',
  cap: CAP,
  description: describe(
    'Quality survey results - FFA, M&I, IV and DOBI - by shipment, contract or survey location. ' +
      'These are laboratory measurements in their own units (percentages and index values), not quantities, and are ' +
      'reported exactly as KLIP holds them. At least one of shipment_id or contract_id is required.',
    `Returns at most ${CAP} surveys.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    // Refuse before touching the network. A 404 here would surface as an empty row set,
    // and an empty row set reads as "no survey exists" - a claim about the cargo rather
    // than about the connector.
    if (!routes.quality.verified) {
      throw capabilityUnavailable(
        'Quality survey data (FFA, M&I, IV, DOBI)',
        'KLIP exposes no API for it - the data is reachable only through the KLIP web pages. ' +
          'This is not a statement that no survey exists for your shipment: check the KLIP quality ' +
          'screen directly. An endpoint has been requested from the KLIP team.',
      );
    }

    if (params.shipment_id === undefined && params.contract_id === undefined) {
      throw invalidParams('Provide at least one of shipment_id or contract_id.', {
        required_one_of: ['shipment_id', 'contract_id'],
      });
    }

    const route = routes.quality;
    const filterInput = {
      shipment_id: params.shipment_id,
      contract_id: params.contract_id,
      location: params.location,
    };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(cache.keyFor('klip_quality_surveys', { ...filterInput }), async () =>
      walk<Row>({ route, filters: filters.upstream, maxPages: 2 }),
    );
    const walked = cached.value;

    let rows = walked.rows;
    if (filters.local.length > 0) {
      rows = rows.filter(
        (row) =>
          (!filters.local.includes('shipment_id') ||
            matchesLoosely(pickString(row, fields.quality.shipmentId), params.shipment_id) ||
            matchesLoosely(pickString(row, fields.quality.stoNumber), params.shipment_id)) &&
          (!filters.local.includes('contract_id') ||
            matchesLoosely(pickString(row, fields.quality.contractId), params.contract_id)) &&
          (!filters.local.includes('location') ||
            matchesLoosely(pickString(row, fields.quality.location), params.location)),
      );
    }

    const surveys = rows.slice(0, CAP).map((row) => ({
      shipment_id: pickString(row, fields.quality.shipmentId),
      sto_number: pickString(row, fields.quality.stoNumber),
      contract_id: pickString(row, fields.quality.contractId),
      location: pickString(row, fields.quality.location),
      survey_date: toDateOnly(pickString(row, fields.quality.surveyDate)),
      surveyor: pickString(row, fields.quality.surveyor),
      ffa_pct: pickNumber(row, fields.quality.ffa),
      m_and_i_pct: pickNumber(row, fields.quality.mi),
      iv: pickNumber(row, fields.quality.iv),
      dobi: pickNumber(row, fields.quality.dobi),
    }));

    const data: Record<string, unknown> = {
      surveys,
      matching_surveys: rows.length,
      units_note:
        'FFA and M&I are percentages; IV (iodine value) and DOBI are dimensionless index values. ' +
        'A null means the measurement is not recorded in KLIP for that survey, not that it is zero.',
    };
    // truncated now reports COVERAGE only, so the display bound has to be stated here
    // or the caller cannot tell a shortened list from a complete one.
    data.rows_shown = surveys.length;
    data.matching_rows = walked.fetchedRows;
    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;
    if (surveys.length === 0) {
      data.empty_result_note =
        'No surveys matched. Confirm the shipment or contract id before reporting that no survey exists.';
    }

    return {
      data,
      units: null,
      rowCount: surveys.length,
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

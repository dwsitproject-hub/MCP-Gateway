/**
 * klip_quality_surveys - "DOBI at discharge for STO Z?"
 *
 * LIVE since 9 Sep 2026. This tool refused for two weeks because the endpoint did not
 * exist: the KLIP team confirmed on 27 Aug that there was no /api/quality* route and no
 * REST handler over quality_surveys anywhere in their codebase. They shipped one, and
 * told us on 9 Sep.
 *
 * Re-probed here on 10 Sep before re-enabling, rather than switching it on because a
 * document said so: GET /api/quality-surveys?limit=3 answered 200 in 150 ms with
 * { success, data: { surveys[], pagination } } over 202,338 rows.
 *
 * The refusal it used to raise was the right behaviour and worth keeping in mind: a
 * 404 walked as an empty row set, which this tool then reported as "no surveys
 * matched" - telling a user no survey exists for their cargo when the truth was that
 * the connector could not look. That distinction is why the route carries a `verified`
 * flag and why the guard below still stands.
 *
 * MOISTURE AND IMPURITY ARE SEPARATE COLUMNS. The field map written before the endpoint
 * existed expected a single combined "M&I", which KLIP does not have. Reporting either
 * column under that name would have silently dropped the other, and both are quality
 * limits in their own right.
 *
 * Quality measurements are NOT quantities: FFA, moisture, impurity, IV, DOBI, density,
 * colour and the rest pass through unconverted. Running any of them through kgToMt
 * would be the classic unit accident.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { toDateOnly } from './../../adapters/klip/normalize.js';
import { invalidParams, capabilityUnavailable } from './../../core/errors.js';
import * as cache from './../../core/cache.js';
import { buildFilters, isoDate, localFilterNote, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 20;

const inputShape = {
  shipment_id: z.string().min(1).optional().describe('Shipment id or STO number.'),
  contract_id: z.string().min(1).optional().describe('Contract number.'),
  vessel_name: z.string().min(1).optional().describe('Vessel name, e.g. "EIHO".'),
  location: z.string().min(1).optional().describe('Survey point, as KLIP spells it.'),
  date_from: isoDate.optional().describe('Earliest survey date to include.'),
  date_to: isoDate.optional().describe('Latest survey date to include.'),
};

export const qualitySurveys: ToolDefinition<typeof inputShape> = {
  name: 'klip_quality_surveys',
  title: 'KLIP quality surveys',
  cap: CAP,
  description: describe(
    'Laboratory quality results per survey: FFA, moisture, impurity, IV, DOBI, density, red colour, ' +
      'dirt/sand and stone, with the surveyor, survey date, COA number and any remarks. Filter by ' +
      'shipment or STO, contract, vessel, survey location or survey date. ' +
      'MOISTURE AND IMPURITY ARE SEPARATE MEASUREMENTS - KLIP holds no combined "M&I" figure, so do not ' +
      'add them or present one as both. ' +
      'These are laboratory values in their own units - percentages and dimensionless index numbers - ' +
      'never quantities. Do not convert them and do not describe them as tonnes. A null means the ' +
      'measurement is not recorded for that survey, which is not the same as zero. ' +
      'At least one filter is required: KLIP holds over 200,000 surveys.',
    `Returns at most ${CAP} surveys.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    /**
     * The guard stays, even though the endpoint now exists.
     *
     * It is what turned nineteen 404s into an honest refusal instead of "no surveys
     * matched", and it costs nothing while `verified` is true. If KLIP ever withdraws
     * the route, this fails loudly again rather than quietly reporting that a cargo was
     * never tested.
     */
    if (!routes.quality.verified) {
      throw capabilityUnavailable(
        'Quality survey data (FFA, moisture, impurity, IV, DOBI)',
        'The KLIP endpoint this tool reads is not currently available. This is NOT a statement that no ' +
          'survey exists for your shipment - check the KLIP quality screen directly.',
      );
    }

    const anyFilter =
      params.shipment_id ?? params.contract_id ?? params.vessel_name ?? params.location ?? params.date_from;
    if (anyFilter === undefined) {
      throw invalidParams(
        'Provide at least one filter. KLIP holds 202,338 surveys, so an unfiltered request would return ' +
          'an arbitrary page of them rather than an answer.',
        { required_one_of: ['shipment_id', 'contract_id', 'vessel_name', 'location', 'date_from'] },
      );
    }

    const route = routes.quality;
    const filterInput = {
      shipment_id: params.shipment_id,
      contract_id: params.contract_id,
      vessel_name: params.vessel_name,
      location: params.location,
      date_from: params.date_from,
      date_to: params.date_to,
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
            matchesLoosely(pickString(row, fields.quality.shipmentNumber), params.shipment_id)) &&
          (!filters.local.includes('contract_id') ||
            matchesLoosely(pickString(row, fields.quality.contractNumber), params.contract_id) ||
            matchesLoosely(pickString(row, fields.quality.poNumber), params.contract_id)) &&
          (!filters.local.includes('vessel_name') ||
            matchesLoosely(pickString(row, fields.quality.vesselName), params.vessel_name)) &&
          (!filters.local.includes('location') ||
            matchesLoosely(pickString(row, fields.quality.location), params.location)),
      );
    }

    const f = fields.quality;
    const surveys = rows.slice(0, CAP).map((row) => ({
      shipment_id: pickString(row, f.shipmentId),
      shipment_number: pickString(row, f.shipmentNumber),
      contract_number: pickString(row, f.contractNumber),
      po_number: pickString(row, f.poNumber),
      vessel_name: pickString(row, f.vesselName),
      location: pickString(row, f.location),
      survey_date: toDateOnly(pickString(row, f.surveyDate)),
      surveyor: pickString(row, f.surveyor),
      coa_number: pickString(row, f.coaNumber),
      status: pickString(row, f.status),
      // Laboratory values, each in its own unit. Never converted.
      ffa_pct: pickNumber(row, f.ffa),
      moisture_pct: pickNumber(row, f.moisture),
      impurity_pct: pickNumber(row, f.impurity),
      iv: pickNumber(row, f.iv),
      dobi: pickNumber(row, f.dobi),
      density: pickNumber(row, f.density),
      color_red: pickNumber(row, f.colorRed),
      dirt_sand: pickNumber(row, f.dirtSand),
      stone: pickNumber(row, f.stone),
      remarks: pickString(row, f.remarks),
    }));

    const data: Record<string, unknown> = {
      surveys,
      matching_surveys: rows.length,
      units_note:
        'FFA, moisture and impurity are percentages; IV (iodine value), DOBI, density, red colour, ' +
        'dirt/sand and stone are each in their own unit or dimensionless. None is a quantity and none ' +
        'has been converted. A null means the measurement is not recorded in KLIP for that survey, not ' +
        'that it is zero.',
      moisture_impurity_note:
        'moisture_pct and impurity_pct are SEPARATE measurements. KLIP holds no combined M&I figure, so ' +
        'report them separately and never add them into one.',
    };
    // truncated now reports COVERAGE only, so the display bound has to be stated here
    // or the caller cannot tell a shortened list from a complete one.
    data.rows_shown = surveys.length;
    data.matching_rows = walked.fetchedRows;
    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;
    if (surveys.length === 0) {
      data.empty_result_note =
        'No surveys matched. Confirm the shipment, contract or vessel before reporting that no survey ' +
        'exists - and note the endpoint is live, so an empty result here really is an empty result.';
    }

    return {
      data,
      units: null,
      rowCount: surveys.length,
      // TRUNCATED MEANS COVERAGE, NOT DISPLAY (review KLIP-008).
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

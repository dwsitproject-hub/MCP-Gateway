/**
 * klip_trucking_ops - "Trucking gain/loss this month at plant Y?"
 *
 * Gain/loss is delivered minus sent, in kilograms, aggregated over the full
 * bounded fetch before the row slice. Nulls propagate: a sequence with no
 * delivered weight recorded contributes nothing rather than a fabricated loss.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { gainLossKg, kgToMt, sumKg, toDateOnly } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, isoDate, localFilterNote, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 50;

const inputShape = {
  contract_id: z.string().min(1).optional().describe('Contract id.'),
  plant: z.string().min(1).optional().describe('Plant name exactly as klip_reference reports it.'),
  date_from: isoDate.optional().describe('Earliest sent date to include.'),
  date_to: isoDate.optional().describe('Latest sent date to include.'),
  limit: z.number().int().min(1).max(CAP).default(20).describe(`How many trucking rows to return (max ${CAP}).`),
};

export const truckingOps: ToolDefinition<typeof inputShape> = {
  name: 'klip_trucking_ops',
  title: 'KLIP trucking operations',
  cap: CAP,
  description: describe(
    'Trucking sequences with quantity sent versus delivered and the resulting gain or loss, by contract, plant or ' +
      'date range. Gain/loss is delivered minus sent: a negative figure is a loss in transit. ' +
      'Sequences with a missing weight are excluded from the gain/loss total and counted separately - their ' +
      'gain/loss is unknown, not zero.',
    `Returns at most ${CAP} rows plus aggregates over every matching row fetched.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.trucking;
    const limit = Math.min(params.limit, CAP);

    const filterInput = {
      contract_id: params.contract_id,
      plant: params.plant,
      date_from: params.date_from,
      date_to: params.date_to,
    };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(cache.keyFor('klip_trucking_ops', { ...filterInput }), async () =>
      walk<Row>({ route, filters: filters.upstream }),
    );
    const walked = cached.value;

    let rows = walked.rows;
    if (filters.local.length > 0) {
      rows = rows.filter(
        (row) =>
          (!filters.local.includes('plant') || matchesLoosely(pickString(row, fields.trucking.plant), params.plant)) &&
          (!filters.local.includes('contract_id') ||
            matchesLoosely(pickString(row, fields.trucking.contractId), params.contract_id)),
      );
    }

    const mapped = rows.map((row) => {
      const sent = pickNumber(row, fields.trucking.qtySent);
      const delivered = pickNumber(row, fields.trucking.qtyDelivered);
      return {
        sequence: pickString(row, fields.trucking.sequence),
        contract_id: pickString(row, fields.trucking.contractId),
        plant: pickString(row, fields.trucking.plant),
        truck_number: pickString(row, fields.trucking.truckNumber),
        sent_date: toDateOnly(pickString(row, fields.trucking.sentDate)),
        delivered_date: toDateOnly(pickString(row, fields.trucking.deliveredDate)),
        sent_kg: sent,
        delivered_kg: delivered,
        gain_loss_kg: gainLossKg(sent, delivered),
      };
    });

    const incomplete = mapped.filter((m) => m.gain_loss_kg === null).length;
    const gainLossTotalKg = sumKg(mapped.map((m) => m.gain_loss_kg));
    const totalsKey = walked.truncated ? 'totals_partial' : 'totals';

    const data: Record<string, unknown> = {
      [totalsKey]: {
        sequences: mapped.length,
        qty_sent_mt: kgToMt(sumKg(mapped.map((m) => m.sent_kg))),
        qty_delivered_mt: kgToMt(sumKg(mapped.map((m) => m.delivered_kg))),
        gain_loss_mt: kgToMt(gainLossTotalKg),
        excluded_incomplete_weights: incomplete,
      },
      trucking: mapped.slice(0, limit).map((m) => ({
        sequence: m.sequence,
        contract_id: m.contract_id,
        plant: m.plant,
        truck_number: m.truck_number,
        sent_date: m.sent_date,
        delivered_date: m.delivered_date,
        qty_sent_mt: kgToMt(m.sent_kg),
        qty_delivered_mt: kgToMt(m.delivered_kg),
        gain_loss_mt: kgToMt(m.gain_loss_kg),
      })),
      rows_shown: Math.min(mapped.length, limit),
    };

    if (walked.truncated) {
      data.partial_totals_warning =
        `Labelled ${totalsKey}: the fetch hit its page bound, so these cover only the ${walked.fetchedRows} rows ` +
        'read. Ask the user to narrow by plant or date range before quoting a gain/loss figure.';
    }
    if (incomplete > 0) {
      data.exclusions_note = `${incomplete} sequences have a missing sent or delivered weight and are excluded from gain_loss_mt.`;
    }
    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;
    if (mapped.length === 0) {
      data.empty_result_note = 'No trucking sequences matched. Confirm the plant name with klip_reference.';
    }

    return {
      data,
      units: 'MT',
      rowCount: Math.min(mapped.length, limit),
      truncated: walked.truncated || mapped.length > limit,
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

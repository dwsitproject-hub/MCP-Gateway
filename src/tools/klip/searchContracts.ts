/**
 * klip_search_contracts - "Show active CPO contracts at Tanjung Pura."
 *
 * Pagination plus caps. Aggregates are computed over the full bounded fetch and
 * the row slice is taken afterwards (TSD 7.3), so the summary figures match the
 * KLIP UI for the same filter.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt, outstanding, sumKg, toDateOnly, type ContractLineInput } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, countNotes, isoDate, localFilterNote, matchesLoosely } from './common.js';
import { assertFiltersRecognised } from './filterCheck.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 50;

const inputShape = {
  plant: z.string().min(1).optional().describe('Plant name exactly as klip_reference reports it.'),
  supplier: z.string().min(1).optional().describe('Supplier name exactly as klip_reference reports it.'),
  product: z.string().min(1).optional().describe('Product name, e.g. "CPO".'),
  status: z.string().min(1).optional().describe('Contract status exactly as klip_reference reports it.'),
  date_from: isoDate.optional().describe('Earliest contract date to include.'),
  date_to: isoDate.optional().describe('Latest contract date to include.'),
  limit: z.number().int().min(1).max(CAP).default(20).describe(`How many contract rows to return (max ${CAP}).`),
};

export function toContractLine(row: Row): ContractLineInput {
  return {
    contract_id: pickString(row, fields.contract.id) ?? '(unknown)',
    po_number: pickString(row, fields.contract.poNumber),
    supplier: pickString(row, fields.contract.supplier),
    product: pickString(row, fields.contract.product),
    plant: pickString(row, fields.contract.plant),
    incoterm: pickString(row, fields.contract.incoterm),
    status: pickString(row, fields.contract.status),
    qty_po_kg: pickNumber(row, fields.contract.qtyPo),
    shipped_kg: pickNumber(row, fields.contract.shipped),
    received_kg: pickNumber(row, fields.contract.received),
    // KLIP computes outstanding itself; carry it so the connector can report KLIP's
    // number rather than a second opinion.
    upstream_outstanding: pickNumber(row, fields.contract.outstandingUpstream),
  };
}

export const searchContracts: ToolDefinition<typeof inputShape> = {
  name: 'klip_search_contracts',
  title: 'Search KLIP contracts',
  cap: CAP,
  description: describe(
    'Find KLIP contracts by plant, supplier, product, status or contract-date range, and return the matching ' +
      'contracts with quantity totals across the whole match (not just the rows shown). ' +
      'Resolve plant, supplier, product and status wording with klip_reference before calling this.',
    `Returns at most ${CAP} contract rows plus aggregates over every matching contract that was fetched.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.contracts;
    const limit = Math.min(params.limit, CAP);

    const filterInput = {
      plant: params.plant,
      supplier: params.supplier,
      product: params.product,
      status: params.status,
      date_from: params.date_from,
      date_to: params.date_to,
    };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(
      cache.keyFor('klip_search_contracts', { ...filterInput }),
      async () => walk<Row>({ route, filters: filters.upstream }),
    );
    const walked = cached.value;

    // Filters KLIP could not express are applied here, and declared in the payload.
    let rows = walked.rows;
    if (filters.local.length > 0) {
      rows = rows.filter((row) => {
        const line = toContractLine(row);
        return (
          (!filters.local.includes('plant') || matchesLoosely(line.plant ?? null, params.plant)) &&
          (!filters.local.includes('supplier') || matchesLoosely(line.supplier ?? null, params.supplier)) &&
          (!filters.local.includes('product') || matchesLoosely(line.product ?? null, params.product)) &&
          (!filters.local.includes('status') || matchesLoosely(line.status ?? null, params.status))
        );
      });
    }

    const lines = rows.map((row) => outstanding(toContractLine(row)));

    // Aggregates over every matching row fetched, before slicing.
    const totalsKey = walked.truncated ? 'totals_partial' : 'totals';
    /**
     * Arithmetic on KLIP's rows, not a rival calculation.
     *
     * Summing quantity_ordered over the rows read is the same source reached by addition.
     * An OUTSTANDING total is different: it needs a basis rule, ours differed from KLIP's,
     * and the 24 August ruling settled which governs. So that figure is gone from here -
     * klip_outstanding reports KLIP's own, over the whole matching set.
     */
    const aggregate = {
      // KLIP's population count for this filter, not our tally of the rows we read. The
      // two agree when the fetch is complete and diverge when it is bounded - and the
      // divergence is exactly when reporting our own number would mislead.
      matching_contracts: walked.totalRows ?? lines.length,
      qty_po_mt: kgToMt(sumKg(lines.map((l) => l.qty_po_kg))),
      outstanding_note:
        'No outstanding total here. Use klip_outstanding, which reports KLIP\'s own figure over the whole ' +
        'matching set rather than a second calculation over these rows.',
    };

    const shown = rows.slice(0, limit).map((row) => {
      const line = outstanding(toContractLine(row));
      return {
        contract_id: line.contract_id,
        po_number: line.po_number,
        supplier: line.supplier,
        product: line.product,
        plant: line.plant,
        incoterm: line.incoterm,
        status: line.status,
        contract_date: toDateOnly(pickString(row, fields.contract.contractDate)),
        qty_po_mt: kgToMt(line.qty_po_kg),
        shipped_mt: kgToMt(line.basis === 'shipped' ? line.basis_qty_kg : pickNumber(row, fields.contract.shipped)),
        received_mt: kgToMt(line.basis === 'received' ? line.basis_qty_kg : pickNumber(row, fields.contract.received)),
        outstanding_mt: kgToMt(line.outstanding_kg),
        basis: line.basis,
        data_quality: line.data_quality,
      };
    });

    const data: Record<string, unknown> = {
      [totalsKey]: aggregate,
      contracts: shown,
      rows_shown: shown.length,
    };
    if (walked.truncated) {
      data.partial_totals_warning =
        `The figures above are labelled ${totalsKey} because the fetch hit its page bound: they cover the ` +
        `${walked.fetchedRows} rows read, not every matching contract. Do not present them as a complete total.`;
    }
    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;
    if (shown.length === 0) {
      // An empty result is only reported as "nothing matched" once we know the
      // filter VALUES were real. Otherwise this throws UNKNOWN_FILTER_VALUE, so a
      // typo can never be relayed to the user as "there are no contracts" (H6).
      await assertFiltersRecognised({
        plant: params.plant,
        product: params.product,
        supplier: params.supplier,
        status: params.status,
      });
      data.empty_result_note =
        'No contracts matched these filters. The filter values themselves are all recognised by KLIP, so this is a ' +
        'genuine empty result rather than a mistyped filter.';
    }

    return {
      data,
      units: 'MT',
      rowCount: shown.length,
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
      dataQuality: countNotes(lines),
      klipCalls: walked.calls,
    };
  },
};

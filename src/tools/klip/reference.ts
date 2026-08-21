/**
 * klip_reference - the valid filter values.
 *
 * This tool does not appear in the PRD's catalogue of eight. It was added from
 * design-review finding H6: without it, the model cannot know that "Tanjung Pura"
 * is stored as "TJP", so a mistyped filter returns row_count: 0 and the answer
 * reads as "nothing is outstanding there". A confidently wrong empty result is
 * worse than an error, and it defeats both U1 (ask, don't guess) and M1.
 *
 * The tool derives its vocabulary from the contract population rather than a
 * dedicated KLIP endpoint, so it needs no KLIP feature work. Results are cached.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes, enums } from './../../adapters/klip/routes.js';
import { fields, pickString, type Row } from './../../adapters/klip/fields.js';
import * as cache from './../../core/cache.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 200;

const inputShape = {
  facet: z
    .enum(['all', 'plants', 'products', 'suppliers', 'statuses', 'incoterms'])
    .default('all')
    .describe('Which vocabulary to return.'),
};

function tally(rows: readonly Row[], candidates: readonly string[]): Array<{ value: string; contracts: number }> {
  const counts = new Map<string, { display: string; n: number }>();
  for (const row of rows) {
    const raw = pickString(row, candidates);
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { display: trimmed, n: 1 });
    else existing.n += 1;
  }
  return [...counts.values()]
    .map((v) => ({ value: v.display, contracts: v.n }))
    .sort((a, b) => b.contracts - a.contracts || a.value.localeCompare(b.value))
    .slice(0, CAP);
}

export const reference: ToolDefinition<typeof inputShape> = {
  name: 'klip_reference',
  title: 'KLIP reference values',
  cap: CAP,
  description: describe(
    'List the filter values that actually exist in KLIP: plant names, product names, supplier names, contract ' +
      'statuses and incoterms, each with how many contracts use it. ' +
      'CALL THIS FIRST whenever a user names a plant, product or supplier in words, and use the exact value it ' +
      'returns in the other tools. If the user\'s wording matches no value here, ask them which one they meant ' +
      'instead of guessing - a filter value KLIP does not recognise returns an empty result, which must never be ' +
      'reported as "there is nothing".',
    `Returns up to ${CAP} values per facet, most-used first.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.contracts;

    const cached = await cache.through(cache.keyFor('klip_reference', { facet: 'all' }), async () =>
      walk<Row>({ route, filters: {} }),
    );
    const walked = cached.value;
    const rows = walked.rows;

    const wants = (facet: string): boolean => params.facet === 'all' || params.facet === facet;

    const data: Record<string, unknown> = {
      derived_from: 'the contract population currently visible to the read-only service account',
    };
    if (wants('plants')) data.plants = tally(rows, fields.contract.plant);
    if (wants('products')) data.products = tally(rows, fields.contract.product);
    if (wants('suppliers')) data.suppliers = tally(rows, fields.contract.supplier);
    if (wants('statuses')) data.statuses = tally(rows, fields.contract.status);
    if (wants('incoterms')) {
      data.incoterms = tally(rows, fields.contract.incoterm);
      data.incoterm_outstanding_basis = {
        shipped_basis: enums.shippedBasisIncoterms,
        received_basis: enums.receivedBasisIncoterms,
        note:
          'An incoterm not listed in either group has no defensible outstanding basis, so contracts using it are ' +
          'excluded from outstanding totals and flagged as a data-quality note rather than assumed.',
      };
    }

    if (walked.truncated) {
      data.completeness_warning =
        'The contract fetch hit its page bound, so this vocabulary may be missing values that appear only in ' +
        'contracts beyond the bound. Treat a near-miss on a user\'s wording as worth asking about.';
    }

    const rowCount = Object.values(data).filter(Array.isArray).reduce<number>((n, arr) => n + arr.length, 0);

    return {
      data,
      units: null,
      rowCount,
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

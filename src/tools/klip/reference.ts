/**
 * klip_reference - the valid filter values.
 *
 * This tool does not appear in the PRD's catalogue of eight. It was added from
 * design-review finding H6: without it, the model cannot know that "Tanjung Pura"
 * is stored as "TJP", so a mistyped filter returns row_count: 0 and the answer
 * reads as "nothing is outstanding there". A confidently wrong empty result is
 * worse than an error, and it defeats both U1 (ask, don't guess) and M1.
 *
 * Two sources, and the difference is reported rather than blurred.
 *
 * CANONICAL - KLIP's own filter-option endpoints, the same lists its UI uses. These are
 * the complete domain. Only three exist: group-plants, incoterms, b2b-flags.
 *
 * SAMPLED - products, suppliers and statuses have no such endpoint (404), so they are
 * still tallied from contract rows. A sample proves what EXISTS, never what the full
 * domain is, and saying so matters: the incoterm sample only ever produced FOB, FRC and
 * LCO, while the canonical list has six values including CFR and Blank. Reporting a
 * 1,000-row sample as the vocabulary understated it by a third.
 */
import { z } from 'zod';
import { fetchOne, walk } from './../../adapters/klip/paginate.js';
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
    const wants = (facet: string): boolean => params.facet === 'all' || params.facet === facet;

    // Canonical lists first. They are cheap, complete, and make the sampled facets'
    // limitations obvious by contrast.
    const canonical = await cache.through(cache.keyFor('klip_reference_canonical', {}), async () => {
      const [plants, incoterms, b2b] = await Promise.all([
        fetchOne<string[]>(routes.filterOptionsGroupPlants.path, routes.filterOptionsGroupPlants.rowsPath),
        fetchOne<string[]>(routes.filterOptionsIncoterms.path, routes.filterOptionsIncoterms.rowsPath),
        fetchOne<string[]>(routes.filterOptionsB2bFlags.path, routes.filterOptionsB2bFlags.rowsPath),
      ]);
      return { plants, incoterms, b2b };
    });

    const cached = await cache.through(cache.keyFor('klip_reference', { facet: 'all' }), async () =>
      walk<Row>({ route, filters: {} }),
    );
    const walked = cached.value;
    const rows = walked.rows;

    const data: Record<string, unknown> = {};

    const canonicalPlants = canonical.value.plants;
    if (wants('plants')) {
      if (Array.isArray(canonicalPlants)) {
        data.plants = canonicalPlants.map((value) => ({ value }));
        data.plants_source = 'canonical: KLIP filter-options/group-plants, the complete set';
        data.plants_caveat =
          'These are CONTRACT group-plant values and are NOT a site register. A group plant is a ' +
          'reporting bucket; the site register is master_plants.plant_name. The single "TJ PURA" value ' +
          'here covers EIGHT distinct plants - EUP Biodiesel, Biodiesel Old, Biomass, Edible Oil, ' +
          'General, Oleo Chemical (two spellings) and MPE Edible Oil - confirmed by the KLIP team on ' +
          '28 Aug 2026 from master_plants.group_plant. Trucking works at site level and distinguishes ' +
          'them; contract reporting rolls them up, because that is what the group dimension is for. ' +
          'Never report a group-plant figure as one physical site. The rollup is the AGREED reporting ' +
          'standard, confirmed by Jerry (KPN Downstream IT) in Sep 2026 after KLIP put the question to ' +
          'him - so this is settled, not a limitation waiting on a decision.';
      } else {
        data.plants = tally(rows, fields.contract.plant);
        data.plants_source = 'sampled from contract rows: the canonical list could not be read';
      }
    }

    // No filter-option endpoint exists for these three, so they stay samples and say so.
    if (wants('products')) {
      data.products = tally(rows, fields.contract.product);
      data.products_source = 'sampled from contract rows: KLIP exposes no products filter-option endpoint';
    }
    if (wants('suppliers')) {
      data.suppliers = tally(rows, fields.contract.supplier);
      data.suppliers_source = 'sampled from contract rows: KLIP exposes no suppliers filter-option endpoint';
    }
    if (wants('statuses')) {
      data.statuses = tally(rows, fields.contract.status);
      data.statuses_source = 'sampled from contract rows: KLIP exposes no statuses filter-option endpoint';
      data.statuses_caveat =
        'The contract DETAIL endpoint returns values outside this set - "ACTIVE" where the list ' +
        'reports "Open". Raised with the KLIP team; prefer the list vocabulary when filtering.';
    }

    if (wants('incoterms')) {
      const canonicalIncoterms = canonical.value.incoterms;
      if (Array.isArray(canonicalIncoterms)) {
        const sampled = tally(rows, fields.contract.incoterm);
        const seen = new Set(sampled.map((v) => v.value.trim().toLowerCase()));
        const canonicalKeys = new Set(canonicalIncoterms.map((v) => v.trim().toLowerCase()));
        const known = new Set<string>([
          ...enums.shippedBasisIncoterms,
          ...enums.receivedBasisIncoterms,
        ]);

        /**
         * The union, not either list alone.
         *
         * The canonical list alone hides a value that appears on real rows but is not in
         * it - and a user asking about that contract would be told the incoterm does not
         * exist, which is the failure this tool was built to prevent. The sample alone
         * understates the domain. Reporting both, each labelled, is the only version that
         * cannot mislead in either direction.
         */
        const extras = sampled
          .map((v) => v.value)
          .filter((v) => !canonicalKeys.has(v.trim().toLowerCase()));

        data.incoterms = [
          ...canonicalIncoterms.map((value) => ({
            value,
            in_canonical_list: true,
            seen_in_sample: seen.has(value.trim().toLowerCase()),
          })),
          ...extras.map((value) => ({ value, in_canonical_list: false, seen_in_sample: true })),
        ];
        data.incoterms_source =
          'canonical: KLIP filter-options/incoterms, plus any value found on contract rows but absent from it';
        if (extras.length > 0) {
          data.incoterms_outside_canonical = extras;
          data.incoterms_outside_canonical_note =
            `These appear on contract rows but not in KLIP's canonical list: ${extras.join(', ')}. ` +
            'Usable as filter values because the data contains them, but worth raising with KLIP - ' +
            'either the list is incomplete or those rows carry a value KLIP no longer recognises.';
        }
        /**
         * Nothing is unclassified any more, so this reports which incoterms take KLIP's
         * FALLBACK rule rather than a named one. Until 28 Aug 2026 the same list was
         * published as "no defensible basis" and those contracts were excluded from
         * outstanding - which, as the KLIP team pointed out, dropped precisely the
         * contracts with no movement at all, the ones sitting at 100% outstanding.
         */
        const fallback = [...canonicalIncoterms, ...extras].filter(
          (v) => !known.has(v.trim().toLowerCase()),
        );
        if (fallback.length > 0) {
          data.incoterms_on_fallback_basis = fallback;
          data.incoterms_on_fallback_basis_note =
            `These incoterms are not named in KLIP's basis SQL, so they take its ELSE rule: ` +
            `${fallback.join(', ')}. Outstanding for them uses the RECEIVED quantity when it is ` +
            'non-zero and the SHIPPED quantity otherwise. They are counted, not excluded.';
        }
      } else {
        data.incoterms = tally(rows, fields.contract.incoterm);
        data.incoterms_source = 'sampled from contract rows: the canonical list could not be read';
      }
      /**
       * KLIP's own rule, from sqlContractActualQtySubtractedCase, supplied by the KLIP
       * team on 28 Aug 2026:
       *
       *   WHEN inc IN ('FRC', 'CIF', 'CFR') THEN receive
       *   WHEN inc IN ('LCO', 'FOB')        THEN delivery
       *   ELSE COALESCE(NULLIF(receive, 0), delivery)
       */
      data.incoterm_outstanding_basis = {
        shipped_basis: enums.shippedBasisIncoterms,
        received_basis: enums.receivedBasisIncoterms,
        everything_else: 'received when non-zero, otherwise shipped',
        note:
          'This mirrors KLIP\'s own basis SQL, including its ELSE branch, so no incoterm is unclassified and ' +
          'none is excluded. CFR is received-basis and blank takes the ELSE rule. Contract counts by incoterm ' +
          'across all of KLIP, as at 28 Aug 2026: FRC 4,328, LCO 1,806, FOB 912, CIF 161, CFR 8, blank 1.',
      };
    }

    if (Array.isArray(canonical.value.b2b)) {
      data.b2b_flags = canonical.value.b2b.map((value) => ({ value }));
      data.b2b_flags_source = 'canonical: KLIP filter-options/b2b-flags';
    }

    if (walked.truncated) {
      data.sampled_facets_completeness_warning =
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

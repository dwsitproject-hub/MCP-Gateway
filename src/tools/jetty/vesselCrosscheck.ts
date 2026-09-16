/**
 * jetty_vessel_crosscheck - the same vessel in JPS and in KLIP, side by side.
 *
 * WHAT THIS IS NOT: a join. There is no shared identifier between the two systems -
 * measured 11 Sep 2026, of 85 JPS shipment plans NONE carried an externalReference and
 * of 87 shipping instructions NONE carried a KLIP-shaped STO number. The only overlap
 * is the vessel name, and a vessel name is a LABEL, not a key: KLIP shows VICTORIA 11
 * as planned, at-discharge-port and cancelled at the same moment under two spellings,
 * and LUMINOR 6 in five status buckets. One name means many voyages.
 *
 * So similarity scoring cannot make these rows correspond, and this tool does not try.
 * It puts both systems' rows on one screen, each labelled with its source, each KLIP
 * candidate carrying the score that matched it, and NO merged figure anywhere. The
 * reader does the correspondence, knowing what they are doing; the connector declines
 * to do it silently on their behalf.
 *
 * That is the whole design argument. A fuzzy join that is right 80% of the time is
 * worse than none, because the 20% is invisible: a merged row looks exactly like a
 * correct one, and nothing downstream can tell them apart.
 */
import { z } from 'zod';
import { jettyRoutes } from './../../adapters/jetty/routes.js';
import { jettyGet, type JettyCallRecord } from './../../adapters/jetty/session.js';
import { jettyConfigured } from './../../adapters/jetty/client.js';
import { routes } from './../../adapters/klip/routes.js';
import { walk } from './../../adapters/klip/paginate.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt, toDateOnly } from './../../adapters/klip/normalize.js';
import { capabilityUnavailable } from './../../core/errors.js';
import type { CallRecord } from './../../adapters/klip/session.js';
import { describe, type ToolDefinition, type ToolOutcome } from './../klip/types.js';

const CAP = 15;
const DEFAULT_THRESHOLD = 0.8;

const inputShape = {
  vessel_name: z
    .string()
    .min(2)
    .optional()
    .describe('One vessel to look up in both systems. Omit to cross-check every vessel alongside now.'),
  min_similarity: z
    .number()
    .min(0.5)
    .max(1)
    .default(DEFAULT_THRESHOLD)
    .describe(`Name similarity required to list a KLIP row as a candidate (default ${DEFAULT_THRESHOLD}).`),
  limit: z.number().int().min(1).max(CAP).default(CAP).describe(`How many JPS vessels to cover (max ${CAP}).`),
};

interface AtBerthRow {
  vesselName?: string;
  jettyName?: string;
  portName?: string;
  status?: string;
  purpose?: string;
  commodityDisplay?: string;
  cargoSiQty?: number | string;
  referenceNumber?: string;
}

/**
 * Strip the prefixes that are about the HULL, not the identity.
 *
 * BG (barge), MT (motor tanker), MV, KLM, TB (tug) and so on describe what kind of
 * vessel it is; the two systems disagree about whether to include them, and about the
 * dots. "BG KIRANA LIBRA II" and "KIRANA LIBRA II" are one vessel.
 */
const PREFIX = /^(BG|MT|MV|KM|KLM|TB|SPOB|LCT)\.?\s+/i;

export function normaliseVesselName(raw: string): string {
  let s = raw.toUpperCase().replace(/\./g, ' ');
  let previous = '';
  while (previous !== s) {
    previous = s;
    s = s.replace(PREFIX, '').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Dice coefficient over character bigrams.
 *
 * Chosen over edit distance because it is length-normalised and insensitive to word
 * order, which is what vessel names actually vary by. Identical strings score 1.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [g, count] of left) shared += Math.min(count, right.get(g) ?? 0);
  const total = a.length - 1 + (b.length - 1);
  return total === 0 ? 0 : (2 * shared) / total;
}

/**
 * The trailing hull number, compared as a NUMBER so "02" and "2" are one vessel.
 */
function hullNumber(normalised: string): number | undefined {
  const m = /(\d+)$/.exec(normalised);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * Similarity with one domain rule bolted on, and the rule is the important part.
 *
 * Raw bigram similarity scores LUMINOR 2 against LUMINOR 10 at 0.82 - over the 0.8
 * threshold - because the names differ by one character in eighteen. They are
 * different barges. Fleets number their hulls, so the digits carry almost all the
 * identity while contributing almost none of the string, and a similarity measure
 * reads that exactly backwards.
 *
 * So when BOTH names end in a number and the numbers differ, the score is zero
 * regardless of how alike the text is. One name having no number is left to the bigram
 * score, because that is a plausible omission rather than a different hull.
 *
 * Found by a test, not in production: LUMINOR 2, LUMINOR 6 and LUMINOR 10 are all real
 * vessels in KLIP, and matching one barge's contract to another's berth is precisely
 * the silent, plausible-looking error this connector exists to avoid.
 */
export function vesselSimilarity(a: string, b: string): number {
  const left = hullNumber(a);
  const right = hullNumber(b);
  if (left !== undefined && right !== undefined && left !== right) return 0;
  return similarity(a, b);
}

export const jettyVesselCrosscheck: ToolDefinition<typeof inputShape> = {
  name: 'jetty_vessel_crosscheck',
  title: 'One vessel in JPS and KLIP, side by side',
  cap: CAP,
  description: describe(
    'Show what the Jetty Planning System and KLIP each hold about the same vessel, in two clearly ' +
      'separated blocks. JPS gives the berth: jetty, status, purpose, commodity, shipping-instruction ' +
      'quantity. KLIP gives the commercial side: STO, contract, supplier, plant, product, status, ' +
      'quantities. Use it for "what does KLIP say about the vessel at Jetty 2B" or "is this call on a ' +
      'contract we track". ' +
      'THE TWO SYSTEMS ARE MATCHED ON VESSEL NAME ALONE, and the payload says so on every row. There is ' +
      'no shared identifier: JPS plans carry no KLIP reference and KLIP rows carry no JPS operation id, ' +
      'measured across 85 plans and 87 shipping instructions. ' +
      'A vessel NAME IS NOT A KEY - one name covers many voyages, and KLIP routinely shows the same ' +
      'vessel as planned, at discharge port and cancelled at once. Several KLIP candidates for one JPS ' +
      'vessel is the normal case, not an error. ' +
      'NEVER MERGE THE TWO SIDES. Do not add a JPS quantity to a KLIP quantity, do not present one ' +
      'system\'s status as the other\'s, and do not report a single reconciled figure: quote each number ' +
      'with the system it came from. Candidates are a starting point for a human to confirm, not an ' +
      'established link.',
    `Covers at most ${CAP} vessels.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (!jettyConfigured()) {
      throw capabilityUnavailable(
        'Jetty Planning System data',
        'This gateway has no JPS connection configured, so there is no jetty side to compare against.',
      );
    }

    const jettyCalls: JettyCallRecord[] = [];
    const klipCalls: CallRecord[] = [];

    const berth = await jettyGet<AtBerthRow[]>(jettyRoutes.atBerth.path, {}, jettyCalls);
    const alongside = Array.isArray(berth) ? berth : [];

    // With a name given, look that vessel up whether or not it is alongside; otherwise
    // cross-check the board as it stands.
    const subjects =
      params.vessel_name === undefined
        ? alongside.slice(0, params.limit).map((r) => ({ name: r.vesselName ?? '', jps: r }))
        : [
            {
              name: params.vessel_name,
              jps: alongside.find(
                (r) =>
                  normaliseVesselName(r.vesselName ?? '') === normaliseVesselName(params.vessel_name ?? ''),
              ),
            },
          ];

    // One KLIP fetch for the whole comparison. Filtering per vessel upstream would cost
    // a round trip each and still not narrow it, because KLIP matches names its own way.
    const walked = await walk<Row>({ route: routes.shipments, filters: {}, maxPages: 2, calls: klipCalls });
    const klipRows = walked.rows;

    const comparisons = subjects
      .filter((s) => s.name !== '')
      .map((s) => {
        const target = normaliseVesselName(s.name);
        const candidates = klipRows
          .map((row) => {
            const name = pickString(row, fields.shipment.vesselName) ?? '';
            return { row, name, score: name === '' ? 0 : vesselSimilarity(target, normaliseVesselName(name)) };
          })
          .filter((c) => c.score >= params.min_similarity)
          .sort((a, b) => b.score - a.score)
          .slice(0, CAP)
          .map((c) => ({
            match_score: Math.round(c.score * 100) / 100,
            matched_on: 'vessel name only',
            klip_vessel_name: c.name,
            sto_number: pickString(c.row, fields.shipment.stoNumber),
            contract_number: pickString(c.row, fields.shipment.contractId),
            supplier: pickString(c.row, fields.shipment.supplier),
            plant: pickString(c.row, fields.shipment.plant),
            product: pickString(c.row, fields.shipment.product),
            status: pickString(c.row, fields.shipment.status),
            sto_qty_mt: kgToMt(pickNumber(c.row, fields.shipment.stoQty)),
            delivery_end_date: toDateOnly(pickString(c.row, fields.shipment.deliveryEndDate)),
          }));

        const distinctStatuses = new Set(candidates.map((c) => c.status ?? '(none)'));

        return {
          vessel_name: s.name,
          jps: {
            source: 'Jetty Planning System',
            alongside_now: s.jps !== undefined,
            jetty: s.jps?.jettyName ?? null,
            port: s.jps?.portName ?? null,
            status: s.jps?.status ?? null,
            purpose: s.jps?.purpose ?? null,
            commodity: s.jps?.commodityDisplay ?? null,
            si_quantity: s.jps?.cargoSiQty ?? null,
            si_reference: s.jps?.referenceNumber ?? null,
          },
          klip: {
            source: 'KLIP',
            candidate_count: candidates.length,
            candidates,
            // The ambiguity, stated per vessel rather than buried in a footnote. Several
            // statuses at once is KLIP being normal, and it is exactly what makes a
            // single "reconciled" row impossible to construct honestly.
            ambiguity_note:
              candidates.length === 0
                ? 'No KLIP shipment matched this name at this threshold. That is NOT evidence the vessel ' +
                  'is untracked: KLIP may spell it differently, or the call may sit on a contract outside ' +
                  'the rows fetched here.'
                : candidates.length === 1
                  ? 'One candidate at this threshold. Still matched on NAME ALONE - confirm against the ' +
                    'STO before treating it as this voyage.'
                  : `${String(candidates.length)} candidates, carrying ${String(distinctStatuses.size)} ` +
                    'different KLIP statuses. A vessel name covers many voyages, so these are probably ' +
                    'different shipments by the same vessel rather than duplicates. Do not pick one ' +
                    'without checking the STO and dates.',
          },
        };
      });

    const data: Record<string, unknown> = {
      vessels: comparisons,
      vessels_covered: comparisons.length,
      klip_rows_searched: klipRows.length,
      match_basis: {
        method:
          'Dice coefficient over character bigrams of the normalised name, with one domain rule: two ' +
          'names that BOTH end in a number score zero when the numbers differ. LUMINOR 2 and LUMINOR 10 ' +
          'are different barges and score 0.82 on text alone, which would clear any usable threshold.',
        normalisation: 'uppercased, dots removed, hull prefixes stripped (BG, MT, MV, KM, KLM, TB, SPOB, LCT)',
        threshold: params.min_similarity,
        note:
          'Similarity is the ONLY link between these systems. Measured 11 Sep 2026: of 85 JPS shipment ' +
          'plans none carried an externalReference, and of 87 shipping instructions none carried a ' +
          'KLIP-shaped STO number. Nothing here is a confirmed correspondence.',
      },
      do_not_merge:
        'Report each figure with the system it came from. Do NOT add a JPS quantity to a KLIP quantity, ' +
        'do not present one system\'s status as the other\'s, and do not produce a single reconciled ' +
        'number - the two systems measure different things and genuinely disagree. On 11 Sep 2026 JPS ' +
        'had 4 vessels alongside while KLIP showed 12 as berthed or unloading, overlapping on 2.',
      how_to_make_this_a_real_join:
        'JPS shipment plans already carry an externalReference field and it is empty on every row. If ' +
        'planners populate it with the KLIP STO number, this becomes an exact one-to-one link and the ' +
        'name matching can be retired. That is one field on one form.',
    };

    if (comparisons.length === 0) {
      data.empty_result_note =
        params.vessel_name === undefined
          ? 'No vessels are alongside in JPS right now, so there was nothing to cross-check.'
          : `No JPS vessel matched "${params.vessel_name}". The KLIP side was still searched; a vessel ` +
            'not alongside has no JPS berth row by definition.';
    }

    return {
      data,
      units: null,
      rowCount: comparisons.length,
      truncated: alongside.length > comparisons.length && params.vessel_name === undefined,
      asOf: new Date(),
      // Both systems are represented, so the envelope cannot claim either as THE source.
      // Each block names its own, which is the whole point of the tool.
      system: 'jetty',
      klipCalls: [...klipCalls, ...jettyCalls],
    };
  },
};


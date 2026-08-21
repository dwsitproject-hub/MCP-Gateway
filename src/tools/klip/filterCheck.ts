/**
 * Distinguish "no rows matched" from "you filtered on a value KLIP does not know"
 * (review H6).
 *
 * This is the difference between an honest empty result and a confidently wrong
 * "there is nothing outstanding at that plant". It runs ONLY when a result came
 * back empty, so it costs nothing on the normal path, and the vocabulary walk is
 * cached.
 */
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickString, type Row } from './../../adapters/klip/fields.js';
import * as cache from './../../core/cache.js';
import { unknownFilterValue } from './../../core/errors.js';

type Facet = 'plant' | 'product' | 'supplier' | 'status';

const CANDIDATES: Record<Facet, readonly string[]> = {
  plant: fields.contract.plant,
  product: fields.contract.product,
  supplier: fields.contract.supplier,
  status: fields.contract.status,
};

async function knownValues(facet: Facet): Promise<string[]> {
  const cached = await cache.through(cache.keyFor('klip_reference', { facet: 'all' }), async () =>
    walk<Row>({ route: routes.contracts, filters: {} }),
  );
  const seen = new Map<string, string>();
  for (const row of cached.value.rows) {
    const value = pickString(row, CANDIDATES[facet]);
    if (value === null) continue;
    const trimmed = value.trim();
    if (trimmed !== '') seen.set(trimmed.toLowerCase(), trimmed);
  }
  return [...seen.values()];
}

/** Cheap similarity: shared prefix, containment, or a small edit distance. */
function nearMatches(supplied: string, known: readonly string[]): string[] {
  const needle = supplied.trim().toLowerCase();
  const scored = known
    .map((value) => {
      const hay = value.toLowerCase();
      let score = 0;
      if (hay === needle) score = 100;
      else if (hay.includes(needle) || needle.includes(hay)) score = 80;
      else {
        const words = needle.split(/\s+/).filter((w) => w.length > 2);
        if (words.some((w) => hay.includes(w))) score = 60;
        else if (hay[0] === needle[0]) score = 20;
      }
      return { value, score };
    })
    .filter((s) => s.score >= 20)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.value);
}

/**
 * Throw UNKNOWN_FILTER_VALUE when a supplied filter matches no value KLIP holds.
 * Call this only after a query returned zero rows.
 */
export async function assertFiltersRecognised(supplied: Partial<Record<Facet, string | undefined>>): Promise<void> {
  for (const [facet, value] of Object.entries(supplied) as Array<[Facet, string | undefined]>) {
    if (value === undefined || value.trim() === '') continue;
    const known = await knownValues(facet);
    // If the vocabulary itself is empty we cannot conclude anything.
    if (known.length === 0) continue;
    const needle = value.trim().toLowerCase();
    const matched = known.some((k) => k.toLowerCase().includes(needle) || needle.includes(k.toLowerCase()));
    if (!matched) throw unknownFilterValue(facet, value, nearMatches(value, known));
  }
}

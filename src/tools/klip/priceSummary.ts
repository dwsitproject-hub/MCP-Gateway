/**
 * klip_price_summary - contract pricing over EVERY matching contract, not a sample.
 *
 * Written because a model, asked for nine months of price history, correctly concluded
 * that price lived only on the per-contract detail record, estimated several hundred
 * calls, and sampled two contracts a month instead. Its analysis was careful and its
 * caveats were honest, and the premise was wrong: `unit_price`, `contract_value` and
 * `currency` are all on the CONTRACTS LIST - 66 keys, measured on production - and had
 * simply never been mapped. The connector's gap was reported as the API's.
 *
 * A census is eight requests. /contracts accepts limit=1000 un-clamped and production
 * holds 7,531 contracts, so the whole population fits inside the existing page bound.
 * Sampling was never necessary.
 *
 * THREE THINGS THIS TOOL REFUSES TO DO, each because the alternative produces a
 * plausible number that is wrong:
 *
 *   1. Mix currencies. Production carries IDR and US$. A mean across both is not a
 *      price, so currency is part of every group key and never averaged over.
 *   2. Assume the price basis. Quantities are KILOGRAMS behind a unit field reading MT
 *      or KG, and KLIP does not say whether unit_price is per kilogram or per tonne -
 *      a factor of 1000. The basis is MEASURED from contract_value against price x
 *      quantity, the same way the tank farm units are.
 *   3. Report a partial walk as a total. If the fetch does not cover the population,
 *      the result says so before it says anything else.
 */
import { z } from 'zod';
import { routes } from './../../adapters/klip/routes.js';
import { walk } from './../../adapters/klip/paginate.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 60;

/** One page of 1000 x eight pages covers production's 7,531 contracts. */
const CENSUS_PAGE_SIZE = 1000;
const CENSUS_MAX_PAGES = 10;

const inputShape = {
  group_by: z
    .enum(['month', 'incoterm', 'product', 'supplier', 'plant', 'month_incoterm'])
    .default('month_incoterm')
    .describe('How to bucket the contracts. Currency is ALWAYS part of the key and is never averaged across.'),
  plant: z.string().min(1).optional().describe('Group plant as klip_reference reports it.'),
  product: z.string().min(1).optional().describe('Product, e.g. "CPO" or "PK".'),
  incoterm: z.string().min(1).optional().describe('Incoterm, e.g. "FOB", "FRC", "CIF".'),
  supplier: z.string().min(1).optional().describe('Supplier name.'),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Earliest contract date.'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Latest contract date.'),
  limit: z.number().int().min(1).max(CAP).default(CAP).describe(`How many groups to return (max ${CAP}).`),
};

interface Priced {
  price: number;
  qtyKg: number;
  currency: string;
  month: string;
  incoterm: string;
  product: string;
  supplier: string;
  plant: string;
  value: number | null;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Is unit_price per kilogram or per tonne?
 *
 * contract_value = unit_price x quantity answers it, because quantity is kilograms.
 * A ratio near 1 means the price is per kilogram; near 1000 means per tonne. Measured
 * rather than assumed, because the two readings differ by a factor of a thousand and
 * both produce a number that looks like a price.
 */
function priceBasis(rows: Priced[]): { basis: 'per_kg' | 'per_tonne' | 'unknown'; note: string } {
  const ratios: number[] = [];
  for (const r of rows) {
    if (r.value === null || r.value <= 0 || r.price <= 0 || r.qtyKg <= 0) continue;
    ratios.push(r.value / (r.price * r.qtyKg));
  }
  if (ratios.length === 0) {
    return {
      basis: 'unknown',
      note:
        'No contract carried unit_price, quantity and contract_value together, so the price basis could ' +
        'not be established. Quote unit_price as KLIP holds it, name the field, and do not convert it.',
    };
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const agree = ratios.filter((r) => median > 0 && Math.abs(r - median) / median < 0.02).length;
  const basis = `measured on ${String(ratios.length)} contract(s), ${String(agree)} agreeing`;

  if (Math.abs(median - 1) < 0.05) {
    return {
      basis: 'per_kg',
      note: `contract_value divided by (unit_price x quantity) is ${String(round(median))} (${basis}), so unit_price is PER KILOGRAM. Multiply by 1000 for a per-tonne figure.`,
    };
  }
  if (median > 0 && Math.abs(median - 1000) / 1000 < 0.05) {
    return {
      basis: 'per_tonne',
      note: `contract_value divided by (unit_price x quantity) is ${String(round(median))} (${basis}), so unit_price is PER TONNE already. Do not multiply again.`,
    };
  }
  return {
    basis: 'unknown',
    note:
      `contract_value divided by (unit_price x quantity) is ${String(round(median))} (${basis}), which ` +
      'matches neither a per-kilogram nor a per-tonne reading. The basis is UNKNOWN: quote unit_price as ' +
      'the raw field and ask KLIP what it is per before converting.',
  };
}

export const priceSummary: ToolDefinition<typeof inputShape> = {
  name: 'klip_price_summary',
  title: 'KLIP contract prices, over the whole population',
  cap: CAP,
  description: describe(
    'Contract PRICING aggregated across every matching contract in KLIP: contract count, total quantity, ' +
      'volume-weighted average unit price, simple average, minimum, maximum and spread, grouped by month, ' +
      'incoterm, product, supplier or plant. ' +
      'USE THIS FOR ANY PRICE QUESTION rather than fetching contracts one at a time - "what did CPO cost ' +
      'in August", "how has the FOB price moved this year", "which supplier is dearest", "is this quote ' +
      'in line". It reads the contract LIST, which carries unit_price, contract_value and currency, so a ' +
      'full population is a handful of requests and SAMPLING IS NEVER NECESSARY. ' +
      'CURRENCIES ARE NEVER MIXED: KLIP holds IDR and US$, and currency is part of every group key. A ' +
      'figure spanning both would not be a price. ' +
      'THE PRICE BASIS IS MEASURED, NOT ASSUMED: KLIP does not state whether unit_price is per kilogram ' +
      'or per tonne, and quantities are stored in kilograms behind a unit field that reads MT or KG. The ' +
      'tool derives the basis from contract_value and reports it in price_basis_note - read that before ' +
      'quoting or converting any price. ' +
      'The volume-weighted average is the one to quote: a simple mean lets a 50-tonne contract count as ' +
      'much as a 5,000-tonne one. Both are given so the gap between them is visible. ' +
      'Coverage is reported honestly - if the walk did not reach every matching contract the result says ' +
      'so, and the figures must then be described as covering part of the population, never as the ' +
      'market.',
    `Returns at most ${CAP} groups.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.contracts;
    const filterInput = {
      plant: params.plant,
      product: params.product,
      incoterm: params.incoterm,
      supplier: params.supplier,
      date_from: params.date_from,
      date_to: params.date_to,
    };
    const filters = buildFilters(route, filterInput);

    // Big pages on purpose. /contracts accepts limit=1000 un-clamped (verified 21 Aug
    // 2026), so the whole population fits in eight requests where the default 100-row
    // page would need seventy-six and hit the bound long before the end.
    const cached = await cache.through(cache.keyFor('klip_price_summary', { ...filterInput }), async () =>
      walk<Row>({
        route,
        filters: filters.upstream,
        pageSize: CENSUS_PAGE_SIZE,
        maxPages: CENSUS_MAX_PAGES,
      }),
    );
    const walked = cached.value;

    const priced: Priced[] = [];
    let missingPrice = 0;
    for (const row of walked.rows) {
      const price = pickNumber(row, fields.contract.unitPrice);
      const qtyKg = pickNumber(row, fields.contract.qtyPo);
      const date = pickString(row, fields.contract.contractDate) ?? '';
      if (price === null || price <= 0 || qtyKg === null || qtyKg <= 0) {
        missingPrice += 1;
        continue;
      }
      priced.push({
        price,
        qtyKg,
        value: pickNumber(row, fields.contract.contractValue),
        currency: pickString(row, fields.contract.currency) ?? '(no currency)',
        month: date.slice(0, 7) === '' ? '(no date)' : date.slice(0, 7),
        incoterm: (pickString(row, fields.contract.incoterm) ?? '(blank)').toUpperCase(),
        product: pickString(row, fields.contract.product) ?? '(none)',
        supplier: pickString(row, fields.contract.supplier) ?? '(none)',
        plant: pickString(row, fields.contract.plant) ?? '(none)',
      });
    }

    const basis = priceBasis(priced);

    // Currency is ALWAYS in the key. Averaging IDR against US$ would produce a number
    // that is not a price in either currency.
    const keyOf = (r: Priced): string => {
      const dimension =
        params.group_by === 'month'
          ? r.month
          : params.group_by === 'incoterm'
            ? r.incoterm
            : params.group_by === 'product'
              ? r.product
              : params.group_by === 'supplier'
                ? r.supplier
                : params.group_by === 'plant'
                  ? r.plant
                  : `${r.month} ${r.incoterm}`;
      return `${dimension} ${r.currency}`;
    };

    const buckets = new Map<string, Priced[]>();
    for (const r of priced) {
      const k = keyOf(r);
      const list = buckets.get(k) ?? [];
      list.push(r);
      buckets.set(k, list);
    }

    const groups = [...buckets.entries()]
      .map(([key, rows]) => {
        const [dimension = '', currency = ''] = key.split(' ');
        const totalKg = rows.reduce((s, r) => s + r.qtyKg, 0);
        // Volume-weighted: a 50-tonne contract must not move the average as much as a
        // 5,000-tonne one. The simple mean is reported beside it so the gap is visible,
        // because a wide gap means the population is dominated by a few large deals.
        const weighted = totalKg > 0 ? rows.reduce((s, r) => s + r.price * r.qtyKg, 0) / totalKg : null;
        const simple = rows.reduce((s, r) => s + r.price, 0) / rows.length;
        const prices = rows.map((r) => r.price).sort((a, b) => a - b);
        return {
          group: dimension,
          currency,
          contracts: rows.length,
          total_qty_mt: kgToMt(totalKg),
          weighted_avg_price: weighted === null ? null : round(weighted),
          simple_avg_price: round(simple),
          min_price: prices[0] ?? null,
          max_price: prices[prices.length - 1] ?? null,
          median_price: prices[Math.floor(prices.length / 2)] ?? null,
        };
      })
      .sort((a, b) => a.group.localeCompare(b.group) || a.currency.localeCompare(b.currency));

    const data: Record<string, unknown> = {
      grouped_by: params.group_by,
      groups: groups.slice(0, params.limit),
      groups_total: groups.length,
      contracts_priced: priced.length,
      contracts_without_a_usable_price: missingPrice,
      price_basis: basis.basis,
      price_basis_note: basis.note,
      currency_note:
        'Currency is part of every group key and figures are NEVER averaged across currencies. A group ' +
        'labelled IDR and one labelled US$ describe different populations and must not be compared as ' +
        'numbers.',
      which_average_to_quote:
        'weighted_avg_price, which weights each contract by its quantity. simple_avg_price lets a tiny ' +
        'contract count as much as a large one; a wide gap between the two means a few big deals dominate ' +
        'the group, which is itself worth saying.',
      computed_here:
        'Every figure in groups is computed HERE from KLIP\'s own unit_price, quantity and currency ' +
        'fields. KLIP publishes no price aggregate of its own, so there is no upstream number this could ' +
        'disagree with - but it is arithmetic over rows, not a KLIP report, and should be described that ' +
        'way.',
    };

    if (missingPrice > 0) {
      data.excluded_note =
        `${String(missingPrice)} contract(s) carried no usable unit_price or quantity and are excluded ` +
        'from every figure above. They are counted here rather than treated as zero-priced, which would ' +
        'drag every average down.';
    }

    return {
      data,
      // The prices are in each group's own currency; quantities are MT. No single unit
      // covers the payload, so none is claimed.
      units: null,
      rowCount: groups.length,
      truncated: walked.truncated,
      asOf: new Date(),
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

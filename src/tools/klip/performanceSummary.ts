/**
 * klip_performance_summary - KLIP's own contract-performance aggregates.
 *
 * This is the endpoint the KLIP Contract Performance page uses, which is why its totals
 * are coherent where ours are page-bounded: it aggregates across the whole filtered set
 * with no pagination. Per the 24 August ruling, the KLIP outstanding rules govern, so
 * these are the authoritative figures.
 *
 * THE scope=filtered GATE
 *
 * Filters on this endpoint do nothing unless scope=filtered is sent with them. KLIP
 * parses them and skips them, answering the unfiltered YTD question instead - so a plant
 * filter without the gate returns company-wide figures that read as one plant's.
 *
 * That trap is closed by construction: the scope flag is DERIVED from which filters are
 * present, so a caller cannot set one without the other. Relying on remembering would be
 * relying on the thing that already went wrong once.
 *
 * We reported these filters as broken before finding the gate. Worth recording why: we
 * tested scope with all / open / close / ytd - four values we invented - and concluded
 * from their failure. Guessing a parameter's accepted values is not measuring it.
 *
 * WHAT IS DELIBERATELY NOT EXPOSED
 *
 * No contract-status filter. With scope=filtered it still leaves all four card counts
 * unchanged, while plant, search and incoterms narrow correctly. Until KLIP explains
 * that, offering it would be offering a filter that silently does nothing - and the
 * figures are already split into open and closed, which covers the same question.
 *
 * QUANTITIES ARE KILOGRAMS, and are now converted to MT.
 *
 * This tool used to report them raw with "the unit is NOT confirmed", which was the
 * honest position while it was unmeasured and the wrong one once it was not. The cost
 * showed up in a live chat on 4 Sep 2026: asked for CPO outstanding, it published
 * 391,988,806 and refused to call it tonnes, then hedged "roughly 392k MT... don't
 * quote that externally". The user compared it against the page and the ratio settled
 * it twice over:
 *
 *   open outstanding   page 419,223 MT     tool 419,223,245
 *   CPO on time        page 135,320 MT     tool 135,319,964
 *
 * The Oil Loss page states it outright too - "Quantities in MT (stored as Kg)" - and
 * the gateway's own verified knowledge entry says divide by 1,000. A hedge that
 * survives its own evidence stops being caution and becomes a worse answer.
 */
import { z } from 'zod';
import { fetchOne } from './../../adapters/klip/paginate.js';
import type { CallRecord } from './../../adapters/klip/session.js';
import { routes } from './../../adapters/klip/routes.js';
import { invalidParams, upstreamUnavailable } from './../../core/errors.js';
import { kgToMt } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

/**
 * KLIP's YTD window: 1 January of the current year to TODAY, in WIB.
 *
 * WITHOUT DATES, KLIP APPLIES NO WINDOW AT ALL - it returns all-time figures, and says
 * so only by returning ytd_range as {}. That is the single worst default available here,
 * because the numbers look like the page's and are not.
 *
 * Measured 10 Sep 2026, statusCardSummary.openOutstandingQty for product CPO:
 *
 *              no dates      1 Jan - 10 Sep
 *   KARAWANG    128,462          90,885
 *   BEKASI       31,380          13,350
 *   TANGERANG     5,784           4,700
 *   all plants  475,367         417,369
 *
 * A live chat asked for CPO outstanding per plant, omitted the dates, and reported
 * 480,440 MT against the page's 422,442 - then wrote a lateness analysis of Karawang
 * and Bekasi, the two plants the missing window inflated most. Every figure it gave was
 * all-time presented as year-to-date.
 *
 * So the window is now defaulted rather than left to the caller. All-time remains
 * reachable by asking for it explicitly.
 */
function ytdWindow(now = Date.now()): { from: string; to: string } {
  // WIB is UTC+7. Shifting before slicing keeps "today" the Indonesian today rather
  // than yesterday for the seven hours after midnight local.
  const wib = new Date(now + 7 * 60 * 60 * 1000);
  const to = wib.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

/** incoterm > group plant > product > supplier group > supplier, KLIP's own order. */
const LEVELS = ['incoterm', 'group_plant', 'product', 'supplier_group', 'supplier'] as const;
const MAX_DEPTH = LEVELS.length;

const inputShape = {
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Earliest contract date to include.'),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Latest contract date to include.'),
  transport_mode: z.string().min(1).optional().describe('Transport mode: LAND, SEA or MIX.'),
  plant: z.string().min(1).optional().describe('Plant or group-plant exactly as klip_reference reports it.'),
  supplier: z.string().min(1).optional().describe('Supplier name as klip_reference reports it.'),
  product: z.string().min(1).optional().describe('Product name, e.g. "CPO".'),
  incoterm: z
    .string()
    .min(1)
    .optional()
    .describe('One incoterm, or several comma-separated, from klip_reference: FOB, FRC, LCO, CFR, CIF.'),
  search: z.string().min(1).optional().describe('Free-text match across the contract fields KLIP searches.'),
  status: z
    .enum(['Open', 'Close'])
    .optional()
    .describe('Contract status, as the KLIP page sends it. Case-sensitive upstream.'),
  all_time: z
    .boolean()
    .default(false)
    .describe(
      'Drop the date window entirely and report all-time figures. Off by default: without dates KLIP ' +
        'returns all-time, which will not match the KLIP page and is rarely what was asked.',
    ),
  group_by: z
    .enum(['incoterm', 'group_plant', 'product', 'supplier_group', 'supplier'])
    .optional()
    .describe(
      'Aggregate KLIP\'s drilldown to one level and return a flat total per key - the direct way to ' +
        'answer "per plant" or "per supplier". Never loop a filter over each plant instead: that misses ' +
        'the Blank bucket and any value you did not think to query.',
    ),
  breakdown_depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_DEPTH)
    .default(0)
    .describe(
      'How many levels of KLIP\'s drilldown to return. 0 = cards only. 1 incoterm, 2 adds group plant, ' +
        '3 adds product, 4 adds supplier group, 5 adds supplier. KLIP fixes that order.',
    ),
};

/**
 * Node cap across the whole response.
 *
 * A five-level tree over every incoterm, plant, product and supplier is thousands of
 * nodes. Truncating is better than a response nobody can read, and saying so is better
 * than truncating silently - a partial tree presented as complete is the same class of
 * error as a filtered answer presented as a total.
 */
const NODE_BUDGET = 400;

interface TreeNode {
  key?: string;
  count?: number;
  totalDays?: number;
  maxDays?: number;
  totalQtyDelivery?: number;
  children?: TreeNode[];
}

interface Pruned {
  nodes: unknown[];
  truncated: boolean;
}

/**
 * Prune to `depth`, convert quantities to MT, and label each level.
 *
 * Averages are NOT computed here. KLIP gives count, totalDays and maxDays per node; an
 * average is one division away and a caller may well want it, but deriving it here and
 * printing it beside KLIP's own avgDays would put two numbers for the same idea in one
 * response. totalDays and count are both present, so the arithmetic is available
 * without this tool asserting a second figure.
 */
function pruneTree(
  nodes: readonly TreeNode[] | undefined,
  depth: number,
  budget: { left: number },
  // Depth counts DOWN as we recurse, so it cannot name the level - at depth 2 the top
  // node is still `incoterm`. Naming it from MAX_DEPTH - depth labelled a two-level
  // request as supplier_group, and was correct only when depth happened to be 5.
  levelIndex = 0,
): Pruned {
  if (nodes === undefined || depth <= 0) return { nodes: [], truncated: false };
  const out: unknown[] = [];
  let truncated = false;
  for (const node of nodes) {
    if (budget.left <= 0) {
      truncated = true;
      break;
    }
    budget.left -= 1;
    const level = LEVELS[levelIndex] ?? 'unknown';
    const child = pruneTree(node.children, depth - 1, budget, levelIndex + 1);
    if (child.truncated) truncated = true;
    const mapped: Record<string, unknown> = {
      level,
      key: node.key ?? null,
      contracts: node.count ?? null,
      // Named qty_mt, not qty_delivered_mt. KLIP calls the field totalQtyDelivery but
      // renders it as Outstanding Qty in the Open scope and Contract Qty in the Close
      // scope, so a "delivered" label was wrong in both.
      qty_mt: kgToMt(node.totalQtyDelivery ?? null),
      total_days: node.totalDays ?? null,
      max_days: node.maxDays ?? null,
    };
    if (child.nodes.length > 0) mapped.children = child.nodes;
    out.push(mapped);
  }
  return { nodes: out, truncated };
}

/** Filters KLIP applies only when scope=filtered accompanies them. */
const GATED = ['plant', 'supplier', 'product', 'incoterm', 'search'] as const;

interface Cycle {
  count?: number;
  totalDays?: number;
  avgDays?: number;
  maxDays?: number;
  totalQtyDelivery?: number;
  avgLogCycle?: number;
  avgCashCycle?: number;
  openOutstandingQty?: number;
  closeOutstandingQty?: number;
}

/**
 * kg -> MT on every quantity, in place, at any depth.
 *
 * KLIP names quantities consistently - openOutstandingQty, closeOutstandingQty,
 * totalQtyDelivery, distribution.qty - and never uses "qty" for a count or a day
 * figure, so the key is a reliable discriminator. Counts (`count`) and durations
 * (`avgDays`, `avgLogCycle`, `avgCashCycle`, `maxDays`) are left alone; converting one
 * of those would be a far worse error than the one this replaces.
 */
function quantitiesToMt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(quantitiesToMt);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (/qty/i.test(key)) {
      const asNumber = typeof inner === 'number' ? inner : Number(inner);
      out[key] = inner === null || inner === undefined || !Number.isFinite(asNumber) ? null : kgToMt(asNumber);
      continue;
    }
    out[key] = quantitiesToMt(inner);
  }
  return out;
}

/**
 * Aggregate KLIP's own drilldown nodes to one level.
 *
 * This is safe to do - and I had refused to on the grounds that re-aggregating creates
 * a rival figure. Measured 10 Sep 2026 for product CPO, YTD, status Open: summing the
 * plant level across the three trees gives 417,368 MT against the card's 417,369, a 1 MT
 * rounding difference. The parts reconcile, so the aggregation reports KLIP's numbers
 * rather than a second opinion, and the reconciliation is published beside it so a
 * reader can see that for themselves.
 *
 * All THREE trees are walked. tree is the late cohort, onTrackTree the on-time one and
 * unscheduledTree the contracts with no resolvable trade cycle - which for CPO holds
 * 198,211 of the 417,369 MT, so omitting it would understate by nearly half.
 */
function aggregateLevel(
  trees: ReadonlyArray<readonly TreeNode[] | undefined>,
  levelIndex: number,
): Array<{ key: string; qty_mt: number | null; contracts: number }> {
  const acc = new Map<string, { kg: number; contracts: number }>();
  const visit = (nodes: readonly TreeNode[] | undefined, depth: number): void => {
    for (const node of nodes ?? []) {
      if (depth === levelIndex) {
        // KLIP renders the empty-key bucket as `Blank`; it appears in aggregations but
        // never in the vocabulary endpoint, so a per-plant list that drops it fails to
        // sum. A live chat reported exactly this as "1,000 MT not located".
        const key = node.key ?? 'Blank';
        const prev = acc.get(key) ?? { kg: 0, contracts: 0 };
        acc.set(key, {
          kg: prev.kg + Number(node.totalQtyDelivery ?? 0),
          contracts: prev.contracts + Number(node.count ?? 0),
        });
        continue;
      }
      visit(node.children, depth + 1);
    }
  };
  for (const tree of trees) visit(tree, 0);
  return [...acc.entries()]
    .map(([key, v]) => ({ key, qty_mt: kgToMt(v.kg), contracts: v.contracts }))
    .sort((a, b) => (b.qty_mt ?? 0) - (a.qty_mt ?? 0));
}

interface SummaryBody {
  scope?: string;
  ytd_range?: { dateFrom?: string; dateTo?: string };
  summary?: Cycle;
  onTrackSummary?: Cycle;
  statusCardSummary?: Record<string, unknown>;
  distribution?: Record<string, { count?: number; qty?: number }>;
  /** Only on /data. See routes.latePerformanceData. */
  tree?: TreeNode[];
  onTrackTree?: TreeNode[];
  unscheduledTree?: TreeNode[];
}

export const performanceSummary: ToolDefinition<typeof inputShape> = {
  name: 'klip_performance_summary',
  title: 'KLIP contract performance summary',
  cap: 1,
  description: describe(
    'CONTRACT delivery lateness - not vessels. For shipping, vessels, berthing or discharge performance use klip_shipping_performance instead; this tool knows nothing about voyages. ' +
      'Contract delivery performance as KLIP itself computes it: contract counts, average and maximum ' +
      'days late, logistics and cash cycle times, outstanding quantity for open and closed contracts, ' +
      'and the distribution of lateness across buckets (on time, 1-7 days, 8-14, 15-30, 31-60, 61+). ' +
      'Filterable by plant, supplier, product, incoterm, transport mode, free text and date range, all ' +
      'applied by KLIP across the whole matching dataset rather than one page - so these are the ' +
      'figures to quote for a total, and they reconcile against the KLIP Contract Performance page. ' +
      'Resolve plant, supplier, product and incoterm wording with klip_reference first. There is no ' +
      'contract-status filter here, but the figures are already split into open and closed. ' +
      'Quantities are MT, converted from the kilograms KLIP stores. ' +
      'PERIOD: KLIP\'s page defaults to YTD, meaning 1 January to TODAY - not to a month end. When a ' +
      'figure will be compared against the page, match that window; reading "Jan to Sept" as running to ' +
      '30 September pulls in forward-dated contracts and moves every number. ' +
      'Day figures are SIGNED here and the page shows magnitudes, so a cycle this tool reports as -18 ' +
      'appears on screen as 18.',
    'Returns one summary, not rows.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    /**
     * /data when a drilldown is wanted, /summary when it is not.
     *
     * /data is a strict superset - the same four summary objects plus the three trees -
     * so this is purely about not making every caller pay for a five-level tree they
     * did not ask for.
     */
    const wantsTree = params.breakdown_depth > 0 || params.group_by !== undefined;
    const route = wantsTree ? routes.latePerformanceData : routes.latePerformanceSummary;

    const upstream: Record<string, string> = {};
    /**
     * Default to KLIP's YTD window. See ytdWindow: with no dates KLIP reports all-time,
     * which silently inflated a live answer by 58,000 MT against the page.
     */
    const window = params.all_time ? undefined : ytdWindow();
    const dateFrom = params.date_from ?? window?.from;
    const dateTo = params.date_to ?? window?.to;
    if (dateFrom !== undefined) upstream[route.params.dateFrom] = dateFrom;
    if (dateTo !== undefined) upstream[route.params.dateTo] = dateTo;
    if (params.transport_mode !== undefined) upstream[route.params.transportMode] = params.transport_mode;
    if (params.plant !== undefined) upstream[route.params.plant] = params.plant;
    if (params.supplier !== undefined) upstream[route.params.supplier] = params.supplier;
    if (params.product !== undefined) upstream[route.params.product] = params.product;
    if (params.incoterm !== undefined) upstream[route.params.incoterm] = params.incoterm;
    if (params.search !== undefined) upstream[route.params.search] = params.search;
    // Only /data declares status. The KLIP page sends it as Open or Close, exactly -
    // any other casing matches nothing upstream and returns zeros rather than an error,
    // which is why the enum is enforced here.
    /**
     * status narrows the DRILLDOWN, not the cards - and only /data declares it.
     *
     * KLIP corrected themselves on 9 Sep 2026 after re-testing: the parameter is
     * explicitly blanked for /late-performance/summary, because that response returns
     * the Open card AND the Close card and so cannot pre-filter rows to one status.
     * They measured it - openOS and closeQty identical with no status, status=Open and
     * status=Close. It does work on the tree, where Open 36 + Close 771 = the 807
     * returned unfiltered.
     *
     * So at breakdown_depth 0 this tool would send it nowhere and answer as though it
     * had been applied. Refusing is the house rule: a filter that silently does nothing
     * is worse than one that is absent, because the caller cannot tell.
     */
    const statusParam = (route.params as { status?: string }).status;
    if (params.status !== undefined) {
      if (statusParam === undefined) {
        throw invalidParams(
          'status only narrows the drilldown, not the summary cards. KLIP blanks it on the summary ' +
            'endpoint, because that response carries both the Open and the Close card and each already ' +
            'counts only its own side. Ask for breakdown_depth 1 or more to filter the tree by status, ' +
            'or read the Open card, which is open-only already.',
          { needs: 'breakdown_depth >= 1', or: 'read all_contracts_by_status.openOutstandingQty' },
        );
      }
      upstream[statusParam] = params.status;
    }

    // The gate, derived rather than remembered. Any gated filter present means
    // scope=filtered must accompany it, or KLIP answers the unfiltered YTD question and
    // the caller gets company-wide figures under their own plant filter.
    const gatedInUse = GATED.filter((k) => params[k] !== undefined);
    if (gatedInUse.length > 0) upstream[route.params.scope] = 'filtered';

    // The window and the scope flag are not dimensions; listing them as "filters
    // applied" made a company-wide answer look narrowed.
    const windowKeys = new Set<string>([route.params.dateFrom, route.params.dateTo, route.params.scope]);
    const dimensions = Object.keys(upstream).filter((k) => !windowKeys.has(k));

    const query = new URLSearchParams(upstream).toString();
    const path = query === '' ? route.path : `${route.path}?${query}`;

    const calls: CallRecord[] = [];
    const cached = await cache.through(
      // The depth is part of the key: the same filters at depth 0 and depth 3 are
      // different responses from different endpoints.
      cache.keyFor('klip_performance_summary', { ...upstream, depth: params.breakdown_depth }),
      async () =>
      // The query string goes on the path: this endpoint takes no pagination, so there
      // is no walk() to thread parameters through.
        fetchOne<SummaryBody>(path, route.rowsPath, calls),
    );

    // A summary object is the whole payload here, so an absent one is an upstream
    // failure rather than an empty result. Reporting zeroes would be a fabricated total.
    const body = cached.value;
    if (body === undefined) {
      throw upstreamUnavailable('KLIP returned no performance summary');
    }

    const data: Record<string, unknown> = {
      scope: body.scope ?? null,
      period: body.ytd_range ?? null,
      // NOT all contracts: `summary` describes the LATE cohort. Its count equals
      // open_late + close_late exactly across five partitions of Bontang/CPO, which is
      // what /late-performance implies. Naming it all_contracts invited the misreading
      // it duly produced.
      late_contracts: quantitiesToMt(body.summary ?? null),
      on_track_only: quantitiesToMt(body.onTrackSummary ?? null),
      // Every contract, split by status. Its openOutstandingQty is the figure that
      // reconciles with the KLIP Contract Performance page - roughly 5x the one under
      // late_contracts, which counts only late contracts.
      all_contracts_by_status: quantitiesToMt(body.statusCardSummary ?? null),
      lateness_distribution: quantitiesToMt(body.distribution ?? null),
      ...(() => {
        if (params.group_by === undefined) return {};
        const levelIndex = LEVELS.indexOf(params.group_by);
        const groups = aggregateLevel([body.tree, body.onTrackTree, body.unscheduledTree], levelIndex);
        const groupsTotal = groups.reduce((a, g) => a + (g.qty_mt ?? 0), 0);
        const cardTotal = kgToMt(
          Number((body.statusCardSummary as { openOutstandingQty?: number } | undefined)?.openOutstandingQty ?? 0),
        );
        return {
          grouped_by: params.group_by,
          groups,
          groups_total_mt: Math.round(groupsTotal * 1000) / 1000,
          groups_reconciliation:
            cardTotal !== null && Math.abs(groupsTotal - cardTotal) <= Math.max(1, cardTotal * 0.001)
              ? `Reconciles: the groups sum to ${Math.round(groupsTotal)} MT against KLIP's own open ` +
                `outstanding of ${Math.round(cardTotal)} MT.`
              : `DOES NOT RECONCILE: the groups sum to ${Math.round(groupsTotal)} MT against KLIP's own ` +
                `open outstanding of ${Math.round(cardTotal ?? 0)} MT. Report KLIP's figure as the total ` +
                'and treat the split as incomplete.',
          groups_note:
            'These are KLIP\'s own drilldown nodes, summed across its late, on-track and unscheduled ' +
            'trees - not a recount. The unscheduled tree matters: for CPO it holds nearly half the ' +
            'outstanding, so a split that omits it understates badly. `Blank` is contracts with no value ' +
            'at this level; it appears here but never in the filter vocabulary, so do not drop it. ' +
            'NEVER answer a per-plant question by looping a plant filter instead - that misses Blank and ' +
            'any value you did not think to query.',
        };
      })(),
      ...(() => {
        // Undefined-safe: `undefined <= 0` is false, so a caller (or a test) that omits
        // the field entirely would otherwise fall through and emit an empty tree.
        if (!(params.breakdown_depth > 0)) return {};
        const budget = { left: NODE_BUDGET };
        const late = pruneTree(body.tree, params.breakdown_depth, budget);
        const onTrack = pruneTree(body.onTrackTree, params.breakdown_depth, budget);
        const unscheduled = pruneTree(body.unscheduledTree, params.breakdown_depth, budget);
        const anyTruncated = late.truncated || onTrack.truncated || unscheduled.truncated;
        return {
          breakdown_levels: LEVELS.slice(0, params.breakdown_depth),
          breakdown_note:
            'KLIP nests its drilldown incoterm > group plant > product > supplier group > supplier, and ' +
            'that order is fixed upstream. A plant-first or supplier-first view holds the same numbers ' +
            'grouped the other way up; this connector does not re-pivot them, because re-aggregating ' +
            'would produce a second set of figures for the same question. Each node carries KLIP\'s ' +
            'count, totalDays and maxDays - divide totalDays by contracts if an average is wanted, ' +
            'rather than expecting one here beside KLIP\'s own avgDays.',
          late_breakdown: late.nodes,
          on_track_breakdown: onTrack.nodes,
          // The bucket a live chat found holding a third of the population: contracts
          // with no resolvable trade cycle, in neither the late nor the on-track counts.
          unscheduled_breakdown: unscheduled.nodes,
          ...(anyTruncated
            ? {
                breakdown_truncated: `The drilldown was cut at ${NODE_BUDGET} nodes, so some branches are ` +
                  'missing and the levels shown do not add up to the cards above. Narrow with plant, ' +
                  'product or incoterm, or ask for a shallower depth.',
              }
            : {}),
        };
      })(),
      /**
       * Three populations, not two. Explained by the KLIP team on 28 Aug 2026, and the
       * third one is why our counts looked incoherent:
       *
       *   933  all contracts matching the filter
       *   622  those with a resolvable trade cycle - the four card counts
       *   396  summary.count, the LATE subset of those 622
       *
       * Contracts with no resolvable trade cycle are in neither the late nor the on-track
       * counter; they go to unscheduledTree and distribution.noData.
       *
       * AND THE QUANTITY DOES NOT MATCH THE COUNT. statusCardSummary.openOutstandingQty
       * accumulates at latePerformance.service.ts:1327, which runs BEFORE the
       * `tradeCycle == null` exit at :1378 - so the quantity covers every open contract,
       * unscheduled ones included, while the count beside it covers only the late subset.
       * Our quantities reconcile with the page; the counts next to them describe a
       * narrower population. That is why a CIF partition reads "2 contracts" for a bucket
       * holding far more than two.
       */
      cohort_note:
        'THE COUNT AND THE QUANTITY DESCRIBE DIFFERENT POPULATIONS. late_contracts counts only contracts ' +
        'KLIP judges late (open_late + close_late), while openOutstandingQty under all_contracts_by_status ' +
        'covers EVERY open contract including those with no resolvable trade cycle, which are in neither ' +
        'the late nor the on-track counter. Quote the quantity as the plant total - it reconciles with the ' +
        'KLIP Contract Performance page - and never divide it by the count beside it, or describe that ' +
        'count as the number of contracts holding that quantity.',
      computed_by:
        'KLIP, over the whole matching dataset with no pagination. These follow the KLIP outstanding ' +
        'rules, which govern by the 24 August ruling. klip_outstanding computes its own figures from ' +
        'contract rows using incoterm-driven basis selection and may differ - do not present figures ' +
        'from both tools in one total without saying which produced which.',
      /**
       * The window is always present now, so "no filters" no longer exists - and saying
       * so matters, because the whole failure this fixes was a caller believing they had
       * year-to-date figures when KLIP had applied no window at all.
       */
      period_applied: params.all_time
        ? 'ALL TIME - no date window. These figures will NOT match the KLIP page, which defaults to YTD.'
        : `Year to date, ${dateFrom} to ${dateTo} - the window the KLIP page uses by default. Without ` +
          'dates KLIP applies none and returns all-time figures, so this is defaulted rather than left ' +
          'to chance.',
      filters_applied:
        dimensions.length === 0
          ? 'No dimension filter: these are company-wide figures for the period above.'
          : `Applied by KLIP across the whole matching dataset: ${dimensions.join(', ')}.`,
      /**
       * Corrected 28 Aug 2026. We had recorded that KLIP's status filter "does not narrow
       * the result". It does - we misread it twice over.
       *
       * First, it is value-sensitive: contract.controller.ts:1215 accepts exactly `Open`,
       * `ACTIVE`, `Close` and `CLOSE`, plus `All Status`/`all` meaning no filter. Anything
       * else, lowercase `open` included, falls to an exact-equality branch that matches
       * nothing and returns zeros.
       *
       * Second, statusCardSummary is ALREADY split into open and close cards. Filtering to
       * Open leaves the open pair unchanged and zeroes the close pair - so if you watch the
       * open counts, "unchanged" is exactly what a working filter looks like.
       *
       * Still not offered, because the split cards answer the same question without a
       * parameter whose wrong casing silently returns zeros.
       */
      filters_unavailable:
        'No contract-status filter is offered here, because all_contracts_by_status already splits every ' +
        'figure into open and closed. KLIP does have one and it works, but only for the exact strings ' +
        'Open, ACTIVE, Close and CLOSE - any other casing returns zeros rather than an error.',
      units_note:
        'Quantities are METRIC TONNES, divided by 1,000 from the kilograms KLIP stores - confirmed against ' +
        'the KLIP Contract Performance page, where 419,223,245 renders as 419,223 MT. Counts and day ' +
        'figures are untouched.',
    };

    return {
      data,
      units: 'MT',
      rowCount: 1,
      // Aggregated server-side over the full set, so this is the one place in the
      // connector where completeness is not in question.
      truncated: false,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      // Real records from the fetch, not a synthesised one - the audit trail is
      // evidence, and a fabricated timing is worse than an absent one.
      klipCalls: calls,
    };
  },
};

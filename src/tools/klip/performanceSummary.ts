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
 * Quantity units on this endpoint are unestablished, so nothing is converted.
 */
import { z } from 'zod';
import { fetchOne } from './../../adapters/klip/paginate.js';
import type { CallRecord } from './../../adapters/klip/session.js';
import { routes } from './../../adapters/klip/routes.js';
import { upstreamUnavailable } from './../../core/errors.js';
import * as cache from './../../core/cache.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

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
};

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

interface SummaryBody {
  scope?: string;
  ytd_range?: { dateFrom?: string; dateTo?: string };
  summary?: Cycle;
  onTrackSummary?: Cycle;
  statusCardSummary?: Record<string, unknown>;
  distribution?: Record<string, { count?: number; qty?: number }>;
}

export const performanceSummary: ToolDefinition<typeof inputShape> = {
  name: 'klip_performance_summary',
  title: 'KLIP contract performance summary',
  cap: 1,
  description: describe(
    'Contract delivery performance as KLIP itself computes it: contract counts, average and maximum ' +
      'days late, logistics and cash cycle times, outstanding quantity for open and closed contracts, ' +
      'and the distribution of lateness across buckets (on time, 1-7 days, 8-14, 15-30, 31-60, 61+). ' +
      'Filterable by plant, supplier, product, incoterm, transport mode, free text and date range, all ' +
      'applied by KLIP across the whole matching dataset rather than one page - so these are the ' +
      'figures to quote for a total, and they reconcile against the KLIP Contract Performance page. ' +
      'Resolve plant, supplier, product and incoterm wording with klip_reference first. There is no ' +
      'contract-status filter here, but the figures are already split into open and closed. ' +
      'QUANTITIES ARE UNCONVERTED: the unit is not confirmed, so do not describe them as tonnes or ' +
      'kilograms.',
    'Returns one summary, not rows.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.latePerformanceSummary;

    const upstream: Record<string, string> = {};
    if (params.date_from !== undefined) upstream[route.params.dateFrom] = params.date_from;
    if (params.date_to !== undefined) upstream[route.params.dateTo] = params.date_to;
    if (params.transport_mode !== undefined) upstream[route.params.transportMode] = params.transport_mode;
    if (params.plant !== undefined) upstream[route.params.plant] = params.plant;
    if (params.supplier !== undefined) upstream[route.params.supplier] = params.supplier;
    if (params.product !== undefined) upstream[route.params.product] = params.product;
    if (params.incoterm !== undefined) upstream[route.params.incoterm] = params.incoterm;
    if (params.search !== undefined) upstream[route.params.search] = params.search;

    // The gate, derived rather than remembered. Any gated filter present means
    // scope=filtered must accompany it, or KLIP answers the unfiltered YTD question and
    // the caller gets company-wide figures under their own plant filter.
    const gatedInUse = GATED.filter((k) => params[k] !== undefined);
    if (gatedInUse.length > 0) upstream[route.params.scope] = 'filtered';

    const query = new URLSearchParams(upstream).toString();
    const path = query === '' ? route.path : `${route.path}?${query}`;

    const calls: CallRecord[] = [];
    const cached = await cache.through(cache.keyFor('klip_performance_summary', upstream), async () =>
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
      all_contracts: body.summary ?? null,
      on_track_only: body.onTrackSummary ?? null,
      by_status: body.statusCardSummary ?? null,
      lateness_distribution: body.distribution ?? null,
      computed_by:
        'KLIP, over the whole matching dataset with no pagination. These follow the KLIP outstanding ' +
        'rules, which govern by the 24 August ruling. klip_outstanding computes its own figures from ' +
        'contract rows using incoterm-driven basis selection and may differ - do not present figures ' +
        'from both tools in one total without saying which produced which.',
      filters_applied:
        Object.keys(upstream).length === 0
          ? 'None. These are company-wide figures for the year to date.'
          : `Applied by KLIP across the whole matching dataset: ${Object.keys(upstream).join(', ')}.`,
      filters_unavailable:
        'No contract-status filter: KLIP accepts one here but it does not narrow the result, so it is ' +
        'not offered. The figures are already split into open and closed, which covers the same ' +
        'question.',
      units_note:
        'Quantity figures are reported exactly as KLIP returns them. The unit is NOT confirmed and no ' +
        'conversion has been applied. Do not describe them as MT or kg.',
    };

    return {
      data,
      units: null,
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

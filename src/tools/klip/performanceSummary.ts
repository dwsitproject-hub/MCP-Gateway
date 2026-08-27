/**
 * klip_performance_summary - KLIP's own contract-performance aggregates.
 *
 * This is the endpoint the KLIP Contract Performance page uses, which is why its totals
 * are coherent where ours are page-bounded: it aggregates across the whole filtered set
 * with no pagination. Per the 24 August ruling, the KLIP outstanding rules govern, so
 * these are the authoritative figures.
 *
 * WHY THIS IS A SEPARATE TOOL RATHER THAN A MODE OF klip_outstanding
 *
 * The endpoint honours only two of the thirteen filters KLIP documented. Probed 27 Aug
 * across scope=all/open/close/ytd and with no scope, 15 combinations:
 *
 *   HONOURED   transportMode, dateFrom / dateTo
 *   IGNORED    incoterms, status, plant
 *
 * If klip_outstanding switched to this endpoint for unfiltered questions and kept its own
 * calculation for filtered ones, the same question would be answered by two different
 * rule sets depending on whether a filter was set - and nothing in the response would say
 * so. Two tools, each stating whose arithmetic it reports, is the honest arrangement.
 *
 * WHAT IS DELIBERATELY NOT EXPOSED
 *
 * No plant, incoterm, status, supplier or product parameter. Accepting one that KLIP
 * discards would return company-wide figures labelled as one plant, which is the worst
 * failure this connector can produce: confidently wrong, with no error anywhere. A
 * parameter absent from the schema is a limitation the caller can see; a parameter that
 * silently does nothing is a lie.
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
  transport_mode: z
    .string()
    .min(1)
    .optional()
    .describe('Transport mode: LAND, SEA or MIX. The only non-date filter this endpoint applies.'),
};

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
      'These are the figures the KLIP Contract Performance page shows, aggregated over the whole ' +
      'matching dataset rather than one page, so they are the ones to quote for a company total. ' +
      'ONLY date range and transport mode narrow these figures - there is no plant, supplier, product, ' +
      'status or incoterm filter, because KLIP ignores those on this endpoint. For a per-plant or ' +
      'per-supplier breakdown use klip_outstanding, whose figures are computed by this connector and ' +
      'may differ. QUANTITIES ARE UNCONVERTED: the unit is not confirmed, so do not describe them as ' +
      'tonnes or kilograms.',
    'Returns one summary, not rows.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.latePerformanceSummary;

    const upstream: Record<string, string> = {};
    if (params.date_from !== undefined) upstream[route.params.dateFrom] = params.date_from;
    if (params.date_to !== undefined) upstream[route.params.dateTo] = params.date_to;
    if (params.transport_mode !== undefined) upstream[route.params.transportMode] = params.transport_mode;

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
          ? 'None. These are company-wide figures.'
          : `Applied by KLIP: ${Object.keys(upstream).join(', ')}.`,
      filters_unavailable:
        'KLIP ignores plant, incoterm, status, supplier and product on this endpoint, so they are not ' +
        'offered here. A breakdown by those dimensions must come from klip_outstanding.',
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

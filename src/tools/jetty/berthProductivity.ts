/**
 * jetty_berth_productivity - the JPS Management Dashboard KPIs, computed the way the
 * page computes them.
 *
 * I assumed these came from an endpoint and said so in jetty_voyage_history. They do
 * not. ManagementDashboard.jsx calls /operations and derives every figure in the
 * browser, so there is no upstream number to defer to - and that changes what "one
 * source of data" means here. Matching the page requires replicating its arithmetic
 * EXACTLY, and the arithmetic has five details that a reasonable independent
 * implementation would get wrong:
 *
 *   1. COHORT is status === 'SAILED' AND a cast-off timestamp. Not "alongside during
 *      the window", not "completed".
 *   2. DEDUPLICATION by vessel + berthing time. The same call can appear twice in
 *      /operations; the page counts it once.
 *   3. THROUGHPUT SUMS THE UNDEDUPLICATED ROWS while every median uses the deduplicated
 *      ones. Asymmetric, deliberate upstream, and invisible unless you read the source.
 *   4. OUTLIER GUARDS. A wait longer than the berth stay is discarded, as is a wait over
 *      8,760 hours - defences against a corrupt TA. Without them one bad row moves the
 *      median.
 *   5. WINDOW is half-open on CAST-OFF: [start, end). JPS applies the lower bound
 *      server-side via cast_off_from; the upper bound and the half-open edge are
 *      applied here, because the endpoint has no cast_off_to.
 *
 * Source: Frontend/src/pages/ManagementDashboard.jsx, computeFlow() and toRow(), read
 * 22 Sep 2026. If that file changes, this drifts - which is why the payload names the
 * commit-date of the reading and says the figures are replicated rather than served.
 */
import { z } from 'zod';
import { jettyRoutes } from './../../adapters/jetty/routes.js';
import { jettyGet, type JettyCallRecord } from './../../adapters/jetty/session.js';
import { jettyConfigured } from './../../adapters/jetty/client.js';
import { cfg } from './../../core/config.js';
import { capabilityUnavailable } from './../../core/errors.js';
import { describe, type ToolDefinition, type ToolOutcome } from './../klip/types.js';

const CAP = 1;
const H = 3_600_000;
/** Beyond this a TA is treated as corrupt, exactly as the page does. */
const MAX_WAIT_HOURS = 8760;

const inputShape = {
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start of the window, inclusive.'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End of the window, inclusive.'),
  purpose: z
    .enum(['All', 'Loading', 'Unloading'])
    .default('All')
    .describe('Matches the All / Loading / Unloading toggle on the dashboard.'),
  include_ops_ratio: z
    .boolean()
    .default(false)
    .describe(
      'Also compute the effective ops ratio. Needs ONE EXTRA CALL PER VOYAGE, so a 40-voyage month is 40 ' +
        'more requests - off by default.',
    ),
};

interface OperationRow {
  id?: string | number;
  vesselName?: string;
  purpose?: string;
  status?: string;
  portName?: string;
  cargoSiQty?: number | string;
  ta?: string;
  tbAt?: string;
  dockingStartTime?: string;
  estimatedCompletionTime?: string;
  operationsCompletedAt?: string;
  castOffAt?: string;
}

interface Activity {
  milestoneKey?: string;
  startAt?: string;
  endAt?: string;
}

const ms = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Hours between two instants to one decimal, or null if either is missing. */
function hrs(from: string | undefined, to: string | undefined): number | null {
  const a = ms(from);
  const b = ms(to);
  if (a === null || b === null) return null;
  return Number(((b - a) / H).toFixed(1));
}

/** The page's median: sorted, mean of the middle pair when even. */
function median(values: Array<number | null>): number | null {
  const s = values.filter((v): v is number => v !== null && v !== undefined).sort((x, y) => x - y);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] ?? null) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

interface FlowRow {
  vessel: string;
  tb: string | undefined;
  qty: number;
  berth: number | null;
  wait: number | null;
  late: number | null;
  opsH: number | null;
  operationId: string | undefined;
}

export const jettyBerthProductivity: ToolDefinition<typeof inputShape> = {
  name: 'jetty_berth_productivity',
  title: 'JPS Management Dashboard KPIs',
  cap: CAP,
  description: describe(
    'The headline KPIs from the JPS Management Dashboard for a date window: cargo throughput, voyages ' +
      'sailed, median berth time (TB to cast-off), median wait to berth (TA to TB), on-time versus ' +
      'estimated completion, median lateness, and optionally the effective ops ratio. ' +
      'Use it for "how did the berths perform in August", "what is our median turnaround", "are we ' +
      'getting worse at waiting". jetty_voyage_history gives the individual voyages behind these ' +
      'figures; this gives the aggregate. ' +
      'THESE ARE THE PAGE\'S OWN FORMULAS, replicated from its source, not an independent calculation. ' +
      'JPS serves no KPI endpoint - the dashboard derives everything in the browser - so matching it ' +
      'means matching its arithmetic, including a deduplication by vessel and berthing time, outlier ' +
      'guards that discard a wait longer than the berth stay, and a throughput that sums the ' +
      'UNDEDUPLICATED rows while the medians use the deduplicated ones. ' +
      'The window is half-open on CAST-OFF date, matching the dashboard. Voyages are counted only when ' +
      'JPS has status SAILED and a cast-off timestamp. ' +
      'If a figure here disagrees with the screen, report the disagreement rather than choosing - it ' +
      'means the dashboard source has changed and this replica has drifted.',
    'Returns one set of figures for the window.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (!jettyConfigured()) {
      throw capabilityUnavailable(
        'Jetty Planning System data',
        'This gateway has no JPS connection configured. That is a deployment gap, NOT a statement that ' +
          'no voyages sailed - check the JPS Management Dashboard directly.',
      );
    }

    const calls: JettyCallRecord[] = [];
    const route = jettyRoutes.operations;

    /**
     * JPS filters the lower bound itself. cast_off_from was missing from the route map
     * until the server SQL was read; it applies
     * COALESCE(sp.cast_off_at, o.cast_off_at, o.sailed_at, o.actual_completion_time) >= d.
     * It is a lower bound only, so the upper bound stays local - which is also where
     * the dashboard's half-open [start, end) lives.
     */
    const query: Record<string, string | number | undefined> = {};
    if (route.params.castOffFrom !== undefined) {
      query[route.params.castOffFrom] = `${params.date_from}T00:00:00Z`;
    } else if (route.params.startDate !== undefined) {
      query[route.params.startDate] = params.date_from;
    }

    const fetched = await jettyGet<OperationRow[]>(route.path, query, calls);
    const all = Array.isArray(fetched) ? fetched : [];

    // Half-open [start, end), on cast-off, exactly as the dashboard's inWin does.
    const start = Date.parse(`${params.date_from}T00:00:00Z`);
    const end = Date.parse(`${params.date_to}T00:00:00Z`) + 24 * H;

    const sailed: FlowRow[] = all
      .filter((o) => params.purpose === 'All' || o.purpose === params.purpose)
      // The cohort: SAILED with a cast-off. Not "was alongside", not "completed".
      .filter((o) => o.status === 'SAILED' && o.castOffAt !== undefined && o.castOffAt !== '')
      .filter((o) => {
        const t = ms(o.castOffAt);
        return t !== null && t >= start && t < end;
      })
      .map((o) => {
        const tb = o.tbAt ?? o.dockingStartTime;
        const berth = hrs(tb, o.castOffAt);
        let wait = hrs(o.ta, tb);
        // The page's two guards. A wait longer than the whole berth stay, or over a
        // year, is a corrupt TA rather than a real queue - and either would drag the
        // median somewhere no operator would recognise.
        if (wait !== null && berth !== null && wait > berth) wait = null;
        if (wait !== null && wait > MAX_WAIT_HOURS) wait = null;

        const doneOrCastOff = ms(o.operationsCompletedAt ?? o.castOffAt);
        const etc = ms(o.estimatedCompletionTime);
        return {
          vessel: o.vesselName ?? '',
          tb,
          qty: Number(o.cargoSiQty) || 0,
          berth,
          wait,
          late: doneOrCastOff !== null && etc !== null ? Number(((doneOrCastOff - etc) / H).toFixed(1)) : null,
          opsH: null,
          operationId: o.id === undefined ? undefined : String(o.id),
        };
      });

    // Deduplicate by vessel + berthing time: /operations can carry the same call twice.
    const seen = new Set<string>();
    const dd = sailed.filter((r) => {
      const key = `${r.vessel}|${String(r.tb)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Optional, and expensive: one call per voyage. Cargo-operations activities are the
    // only source of the ops hours the ratio needs.
    let effective: number | null = null;
    let opsRatioRows = 0;
    if (params.include_ops_ratio) {
      for (const row of dd) {
        if (row.operationId === undefined) continue;
        try {
          const acts = await jettyGet<Activity[]>(
            `/operations/${encodeURIComponent(row.operationId)}/operational-activities`,
            {},
            calls,
          );
          const ops = (Array.isArray(acts) ? acts : []).filter(
            (a) => a.milestoneKey === 'cargo_operations' && a.startAt !== undefined,
          );
          if (ops.length === 0) continue;
          const st = Math.min(...ops.map((a) => ms(a.startAt) ?? Number.POSITIVE_INFINITY));
          const en = Math.max(...ops.map((a) => ms(a.endAt ?? a.startAt) ?? Number.NEGATIVE_INFINITY));
          if (Number.isFinite(st) && Number.isFinite(en)) row.opsH = Number(((en - st) / H).toFixed(1));
        } catch {
          // One voyage's detail failing must not lose the whole window's KPIs.
        }
      }
      const withBoth = dd.filter((r) => r.berth !== null && r.berth !== 0 && r.opsH !== null);
      opsRatioRows = withBoth.length;
      if (withBoth.length > 0) {
        const opsSum = withBoth.reduce((s, r) => s + (r.opsH ?? 0), 0);
        const berthSum = withBoth.reduce((s, r) => s + (r.berth ?? 0), 0);
        effective = berthSum > 0 ? Number(((opsSum / berthSum) * 100).toFixed(1)) : null;
      }
    }

    const withLate = dd.filter((r) => r.late !== null);
    const onTime =
      withLate.length > 0
        ? Number(((withLate.filter((r) => (r.late ?? 0) <= 0).length / withLate.length) * 100).toFixed(1))
        : null;
    const medianLateHours = median(dd.map((r) => r.late));

    const data: Record<string, unknown> = {
      window: { from: params.date_from, to: params.date_to, purpose: params.purpose, basis: 'cast_off' },
      port_scope: { port_id: cfg.JETTY_PORT_ID ?? null, port_name: all[0]?.portName ?? null },
      kpis: {
        voyages_sailed: dd.length,
        // Sums the UNDEDUPLICATED rows. Asymmetric with the medians below, and that is
        // what the dashboard does - copied rather than corrected, because the figure on
        // the screen is the one people quote.
        cargo_throughput_mt: Math.round(sailed.reduce((s, r) => s + r.qty, 0)),
        median_berth_hours: median(dd.map((r) => r.berth)),
        median_wait_to_berth_hours: median(dd.map((r) => r.wait)),
        on_time_vs_etc_pct: onTime,
        median_lateness_days: medianLateHours === null ? null : Number((medianLateHours / 24).toFixed(1)),
        effective_ops_ratio_pct: effective,
      },
      counts: {
        rows_fetched: all.length,
        in_cohort_before_dedup: sailed.length,
        after_dedup: dd.length,
        with_a_lateness_figure: withLate.length,
        used_for_ops_ratio: opsRatioRows,
      },
      how_these_are_computed:
        'Replicated from the JPS Management Dashboard source (ManagementDashboard.jsx, computeFlow and ' +
        'toRow, read 22 Sep 2026). JPS serves no KPI endpoint - the page derives these in the browser - ' +
        'so these are the SAME formulas rather than an independent calculation. Cohort: status SAILED ' +
        'with a cast-off, cast-off inside a half-open window. Deduplicated by vessel and berthing time. ' +
        'Throughput sums the undeduplicated rows while the medians use the deduplicated ones, which is ' +
        'the dashboard behaviour. A wait longer than the berth stay, or over 8,760 hours, is discarded ' +
        'as a corrupt arrival time.',
      if_it_disagrees_with_the_page:
        'Report the disagreement; do not pick a side. These figures are a replica of code that lives in ' +
        'the JPS frontend, so a mismatch means that code has changed and this needs re-reading - not ' +
        'that one of the two numbers is more correct.',
    };

    if (!params.include_ops_ratio) {
      data.effective_ops_ratio_note =
        'Not computed. It needs the cargo-operations activities for each voyage, which is one extra ' +
        'request per voyage - pass include_ops_ratio to spend them.';
    }
    if (dd.length === 0) {
      data.empty_result_note =
        `No voyage sailed in this window. ${String(all.length)} operation(s) were fetched over the wider ` +
        'plan-eta range, so the fetch worked; none had status SAILED with a cast-off inside the window.';
    }

    return {
      data,
      units: null,
      rowCount: dd.length,
      truncated: false,
      asOf: new Date(),
      system: 'jetty',
      klipCalls: calls,
    };
  },
};

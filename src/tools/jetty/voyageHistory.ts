/**
 * jetty_voyage_history - what happened at the berths over a period.
 *
 * jetty_at_berth answers "now". This answers "since June", which is a different
 * question and needs a different endpoint: /operations, the same rows behind the JPS
 * Management Dashboard voyage drill-down.
 *
 * THE DATE WINDOW MEANS TWO DIFFERENT THINGS AND THE CALLER MUST CHOOSE.
 *
 *   plan_eta   what JPS filters on. Per the TechDoc, start_date/end_date select over
 *              COALESCE(plan.eta, created_at) - operations whose PLAN was due in the
 *              window. A voyage planned for May and cast off in June is IN a May
 *              window and absent from a June one.
 *   cast_off   what the Management Dashboard buckets by, and what people mean by
 *              "berthing data from June". Applied HERE, over rows fetched on a
 *              deliberately wider plan-eta window so late-running voyages are not
 *              silently dropped.
 *
 * Defaulting to cast_off matches the dashboard and the question people actually ask.
 * Saying which was used, on every result, is what stops the two being conflated - and
 * they will differ, because the gap between plan and execution is the thing the
 * dashboard exists to measure.
 *
 * NO MEDIANS HERE. The Management Dashboard publishes median berth time, median wait
 * to berth, effective ops ratio and on-time-vs-ETC. Those are JPS's own figures from an
 * endpoint this connector has not mapped, and computing lookalikes from these rows
 * would put a second set of numbers next to the first. Per-voyage intervals are
 * reported, labelled as computed here; the aggregates belong to the page until the
 * endpoint behind them is mapped.
 */
import { z } from 'zod';
import { jettyRoutes } from './../../adapters/jetty/routes.js';
import { jettyGet, type JettyCallRecord } from './../../adapters/jetty/session.js';
import { jettyConfigured } from './../../adapters/jetty/client.js';
import { cfg } from './../../core/config.js';
import { capabilityUnavailable } from './../../core/errors.js';
import { toWibIso } from './../../adapters/klip/normalize.js';
import { describe, type ToolDefinition, type ToolOutcome } from './../klip/types.js';

const CAP = 50;

/**
 * How far before the requested window to fetch when filtering by cast-off.
 *
 * A voyage planned in April and cast off in June belongs in a June cast-off answer, and
 * JPS will only return it under an April plan-eta window. 120 days is longer than any
 * port stay observed (the dashboard's longest alongside was 9.9 days), with room for a
 * plan raised well before arrival.
 */
const CAST_OFF_LOOKBACK_DAYS = 120;

const inputShape = {
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start of the period, inclusive.'),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End of the period, inclusive.'),
  date_basis: z
    .enum(['cast_off', 'plan_eta'])
    .default('cast_off')
    .describe(
      'cast_off filters on when the vessel actually left, matching the Management Dashboard. ' +
        'plan_eta passes the window straight to JPS, which filters on the PLANNED eta.',
    ),
  purpose: z.string().min(1).optional().describe('Narrow to "Loading" or "Unloading".'),
  jetty_name: z.string().min(1).optional().describe('Narrow to one jetty, e.g. "Jetty 1A".'),
  vessel_name: z.string().min(1).optional().describe('Narrow to one vessel, matched loosely.'),
  limit: z.number().int().min(1).max(CAP).default(CAP).describe(`How many voyages to list (max ${CAP}).`),
};

interface OperationRow {
  id?: string | number;
  portId?: string | number;
  jettyOperationCode?: string;
  vesselName?: string;
  jettyName?: string;
  portName?: string;
  purpose?: string;
  status?: string;
  commodityDisplay?: string;
  commodity?: string;
  cargoSiQty?: number | string;
  cargoSiMetricCode?: string;
  referenceNumber?: string;
  eta?: string;
  ta?: string;
  etb?: string;
  tbAt?: string;
  dockingStartTime?: string;
  estimatedCompletionTime?: string;
  operationsCompletedAt?: string;
  actualCompletionTime?: string;
  norTenderedAt?: string;
  norAcceptedAt?: string;
  castOffAt?: string;
  sailedAt?: string;
  completionPercent?: number;
  exceptionStatus?: string;
}

const loosely = (value: string | undefined, needle: string | undefined): boolean =>
  needle === undefined || (value ?? '').toLowerCase().includes(needle.toLowerCase());

/** Whole-tenths of hours between two instants, or null if either is missing. */
function hoursBetween(from: string | undefined, to: string | undefined): number | null {
  if (from === undefined || to === undefined) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / 3_600_000) * 10) / 10;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const jettyVoyageHistory: ToolDefinition<typeof inputShape> = {
  name: 'jetty_voyage_history',
  title: 'JPS voyages over a period',
  cap: CAP,
  description: describe(
    'Completed and in-progress jetty operations over a DATE RANGE, from the Jetty Planning System: ' +
      'vessel, jetty, purpose, commodity, shipping-instruction quantity, the full milestone ladder ' +
      '(ETA, arrival, ETB, berthed, NOR tendered and accepted, estimated and actual completion, ' +
      'cast-off, sailed) and the per-voyage intervals between them. These are the rows behind the JPS ' +
      'Management Dashboard voyage drill-down. ' +
      'Use this for anything with a period in it - "berthing data since June", "how long did vessels ' +
      'wait last month", "which voyages ran over at Jetty 1A". jetty_at_berth answers only what is ' +
      'alongside RIGHT NOW and holds no history. ' +
      'THE DATE BASIS MATTERS AND IS REPORTED ON EVERY RESULT. cast_off (the default) selects voyages ' +
      'that actually LEFT in the window, matching the Management Dashboard. plan_eta passes the window ' +
      'to JPS, which filters on the PLANNED eta - a voyage planned in May and cast off in June appears ' +
      'in a May plan_eta window, not a June one. The two give different answers on purpose; say which ' +
      'was used. ' +
      'INTERVALS ARE COMPUTED HERE from JPS timestamps and labelled as such. This tool does NOT report ' +
      'median berth time, median wait to berth, effective ops ratio or on-time-vs-ETC: those are the ' +
      'Management Dashboard\'s own figures from an endpoint the connector has not mapped, and a ' +
      'lookalike computed from these rows would be a second answer to a question JPS already answers. ' +
      'A null milestone means JPS has not recorded it, which is NOT the same as the event not happening.',
    `Returns at most ${CAP} voyages.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (!jettyConfigured()) {
      throw capabilityUnavailable(
        'Jetty Planning System history',
        'This gateway has no JPS connection configured. That is a deployment gap, NOT a statement that ' +
          'no voyages happened - check the JPS Management Dashboard directly.',
      );
    }

    const calls: JettyCallRecord[] = [];
    const route = jettyRoutes.operations;

    // Fetch wider than asked when filtering on cast-off, because JPS filters on the
    // PLANNED eta and a late voyage would otherwise fall outside the window it belongs
    // to. Widening costs rows; not widening costs voyages, silently.
    const fetchFrom =
      params.date_basis === 'cast_off' ? shiftDays(params.date_from, -CAST_OFF_LOOKBACK_DAYS) : params.date_from;

    const query: Record<string, string | number | undefined> = {};
    if (route.params.startDate !== undefined) query[route.params.startDate] = fetchFrom;
    if (route.params.endDate !== undefined) query[route.params.endDate] = params.date_to;
    if (params.purpose !== undefined && route.params.purpose !== undefined) {
      query[route.params.purpose] = params.purpose;
    }

    const rows = await jettyGet<OperationRow[]>(route.path, query, calls);
    const fetched = Array.isArray(rows) ? rows : [];

    const from = Date.parse(`${params.date_from}T00:00:00Z`);
    const to = Date.parse(`${params.date_to}T23:59:59Z`);

    const inWindow = fetched.filter((r) => {
      if (params.date_basis === 'plan_eta') return true; // JPS already applied it
      const castOff = r.castOffAt ?? r.sailedAt;
      if (castOff === undefined) return false;
      const t = Date.parse(castOff);
      return Number.isFinite(t) && t >= from && t <= to;
    });

    const matched = inWindow.filter(
      (r) =>
        loosely(r.vesselName, params.vessel_name) &&
        loosely(r.jettyName, params.jetty_name) &&
        loosely(r.purpose, params.purpose),
    );

    // Newest first: a period question is almost always read from the recent end.
    const ordered = [...matched].sort((a, b) => {
      const at = Date.parse(a.castOffAt ?? a.sailedAt ?? a.tbAt ?? '') || 0;
      const bt = Date.parse(b.castOffAt ?? b.sailedAt ?? b.tbAt ?? '') || 0;
      return bt - at;
    });

    const voyages = ordered.slice(0, params.limit).map((r) => {
      const berthed = r.tbAt ?? r.dockingStartTime;
      const opsDone = r.operationsCompletedAt ?? r.actualCompletionTime;
      const left = r.castOffAt ?? r.sailedAt;
      return {
        vessel_name: r.vesselName ?? null,
        jetty: r.jettyName ?? null,
        purpose: r.purpose ?? null,
        status: r.status ?? null,
        operation_code: r.jettyOperationCode ?? null,
        reference_number: r.referenceNumber ?? null,
        commodity: r.commodityDisplay ?? r.commodity ?? null,
        si_quantity: r.cargoSiQty ?? null,
        si_quantity_unit: r.cargoSiMetricCode ?? null,
        eta: toWibIso(r.eta ?? null),
        arrived_at: toWibIso(r.ta ?? null),
        etb: toWibIso(r.etb ?? null),
        berthed_at: toWibIso(berthed ?? null),
        nor_tendered_at: toWibIso(r.norTenderedAt ?? null),
        nor_accepted_at: toWibIso(r.norAcceptedAt ?? null),
        estimated_completion: toWibIso(r.estimatedCompletionTime ?? null),
        operations_completed_at: toWibIso(opsDone ?? null),
        cast_off_at: toWibIso(left ?? null),
        completion_percent: r.completionPercent ?? null,
        exception_status: r.exceptionStatus ?? null,
        /**
         * The three intervals the dashboard splits a port stay into. Subtractions
         * between two timestamps on the same row, not KPIs: JPS defines turnaround its
         * own way and publishes its own medians, and these are the raw material, not a
         * rival to them.
         */
        anchorage_wait_hours: hoursBetween(r.ta, berthed),
        berth_hours: hoursBetween(berthed, left),
        ops_hours: hoursBetween(r.norAcceptedAt ?? berthed, opsDone),
        total_port_hours: hoursBetween(r.ta, left),
      };
    });

    const data: Record<string, unknown> = {
      voyages,
      voyages_in_period: matched.length,
      rows_shown: voyages.length,
      port_scope: {
        port_id: fetched[0]?.portId ?? cfg.JETTY_PORT_ID ?? null,
        port_name: fetched[0]?.portName ?? null,
      },
      window: {
        from: params.date_from,
        to: params.date_to,
        basis: params.date_basis,
        basis_note:
          params.date_basis === 'cast_off'
            ? 'Voyages that CAST OFF inside the window, matching how the JPS Management Dashboard buckets ' +
              `its flow KPIs. JPS itself filters on the planned eta, so rows were fetched from ` +
              `${fetchFrom} - ${String(CAST_OFF_LOOKBACK_DAYS)} days earlier - and narrowed here, so a ` +
              'voyage planned before the window but sailed inside it is still included.'
            : 'Passed straight to JPS, which filters over COALESCE(plan.eta, created_at) - operations ' +
              'whose PLAN was due in the window, NOT what happened in it. A voyage planned in May and ' +
              'cast off in June is in a May window. Use cast_off to ask what actually sailed.',
        rows_fetched_before_narrowing: fetched.length,
      },
      computed_here:
        'anchorage_wait_hours, berth_hours, ops_hours and total_port_hours are subtractions between two ' +
        'timestamps on the same row. Everything else is JPS\'s own field.',
      aggregates_not_reported:
        'Median berth time, median wait to berth, effective ops ratio, on-time vs ETC and median lateness ' +
        'are published by the JPS Management Dashboard from an endpoint this connector has not mapped. ' +
        'They are deliberately NOT recomputed here - a median over the rows above would be a second ' +
        'answer to a question JPS already answers, and the two would drift. Read them from the page, or ' +
        'ask for the endpoint to be mapped.',
      milestone_note:
        'A null timestamp means JPS has not recorded that milestone, not that the event did not happen. ' +
        'An interval is null whenever either end is missing, which is why a voyage can show berth_hours ' +
        'and no ops_hours.',
    };

    if (voyages.length === 0) {
      data.empty_result_note =
        fetched.length === 0
          ? 'JPS returned no operations for this window at all.'
          : `No voyage matched inside the window, though ${String(fetched.length)} operation(s) were ` +
            `fetched over the wider ${params.date_basis === 'cast_off' ? 'plan-eta' : 'requested'} range. ` +
            'With basis=cast_off this usually means the voyages in range have no recorded cast-off yet - ' +
            'try basis=plan_eta, which is what JPS filters on natively.';
    }

    return {
      data,
      units: null,
      rowCount: voyages.length,
      truncated: matched.length > voyages.length,
      asOf: new Date(),
      system: 'jetty',
      klipCalls: calls,
    };
  },
};

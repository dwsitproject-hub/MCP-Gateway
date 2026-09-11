/**
 * jetty_at_berth - "which vessels are alongside right now?"
 *
 * The first JPS tool, and deliberately the question Live Ops exists to answer. Three
 * endpoints, all measured on 11 Sep 2026:
 *
 *   /operations/at-berth               97 ms   bare array, the board itself
 *   /operations/at-berth/cargo-progress 874 ms  { summaries }, live ATG moved-vs-total
 *   /dashboard-v2/atg-sync-health      818 ms  whether that ATG data is fresh
 *
 * THE THIRD CALL IS NOT OPTIONAL. Cargo progress comes from Automatic Tank Gauging, and
 * a stale ATG source means the moved figure stopped advancing while the vessel kept
 * loading. Reporting tonnage without saying whether its source is live is the same
 * class of error as reporting a filtered total as an unfiltered one - it is not wrong
 * on its face, and it cannot be checked by the reader. So the health check travels with
 * the cargo figures, and a stale source is stated in the payload rather than left in a
 * field nobody reads.
 *
 * WHAT THIS TOOL DOES NOT DO: it reports JPS's own fields and computes nothing. No
 * turnaround, no occupancy, no lateness percentage. Those have canonical definitions in
 * the JPS PRD (section 2) and belong to the KPI endpoints that implement them; deriving
 * a lookalike here is how two numbers for one question get born. Alongside duration is
 * the single exception, and it is a subtraction from two timestamps in the same row,
 * labelled as computed here.
 */
import { z } from 'zod';
import { jettyRoutes } from './../../adapters/jetty/routes.js';
import { jettyGet, type JettyCallRecord } from './../../adapters/jetty/session.js';
import { jettyConfigured } from './../../adapters/jetty/client.js';
import { capabilityUnavailable } from './../../core/errors.js';
import { toWibIso } from './../../adapters/klip/normalize.js';
import { describe, type ToolDefinition, type ToolOutcome } from './../klip/types.js';

const CAP = 25;

const inputShape = {
  vessel_name: z
    .string()
    .min(1)
    .optional()
    .describe('Narrow to one vessel, matched loosely against the vessel name.'),
  jetty_name: z.string().min(1).optional().describe('Narrow to one jetty, e.g. "Jetty 1".'),
  limit: z.number().int().min(1).max(CAP).default(CAP).describe(`How many vessels to list (max ${CAP}).`),
};

/** JPS rows are camelCase; these are the fields this tool reads. */
interface AtBerthRow {
  id?: string | number;
  jettyOperationCode?: string;
  vesselName?: string;
  jettyName?: string;
  jettyId?: string | number;
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
  actualCompletionTime?: string;
  operationsCompletedAt?: string;
  norTenderedAt?: string;
  norAcceptedAt?: string;
  demurrageLiabilityFromAt?: string;
  completionPercent?: number;
  castOffAt?: string;
  exceptionStatus?: string;
}

interface CargoSummary {
  operationId?: string | number;
  movedQty?: number;
  totalQty?: number;
  [k: string]: unknown;
}

interface AtgHealth {
  totalEnabled?: number;
  staleCount?: number;
  allHealthy?: boolean;
  checkedAt?: string;
  staleSources?: unknown[];
}

const loosely = (value: string | undefined, needle: string | undefined): boolean =>
  needle === undefined || (value ?? '').toLowerCase().includes(needle.toLowerCase());

/** Whole hours between two instants, or null when either is missing or unparseable. */
function hoursBetween(from: string | undefined, to: number): number | null {
  if (from === undefined) return null;
  const started = Date.parse(from);
  if (!Number.isFinite(started)) return null;
  return Math.round(((to - started) / 3_600_000) * 10) / 10;
}

export const jettyAtBerth: ToolDefinition<typeof inputShape> = {
  name: 'jetty_at_berth',
  title: 'JPS vessels alongside now',
  cap: CAP,
  description: describe(
    'Vessels currently alongside in the Jetty Planning System: vessel, jetty, purpose, commodity, ' +
      'operation status, cargo moved against the shipping-instruction quantity, and the milestone ' +
      'timestamps for the call - arrival, berthing, NOR tendered and accepted, estimated completion, ' +
      'operations completed. This is a LIVE snapshot of the berths right now, not a period report. ' +
      'Every figure is JPS\'s own; this tool computes no KPI. Turnaround, occupancy, on-time and ' +
      'lateness have canonical definitions in JPS and come from its own dashboard endpoints - do not ' +
      'derive them from these rows. ' +
      'Cargo figures come from Automatic Tank Gauging, so the ATG sync health is returned beside them: ' +
      'if a source is stale the moved quantity has stopped advancing while the vessel kept working, and ' +
      'the tonnage must be quoted with that caveat. ' +
      'A null timestamp means the milestone is not recorded in JPS, which is NOT the same as the event ' +
      'not having happened. ' +
      'NOT KLIP. This is the jetty, not the contract pipeline: klip_shipment_status answers shipment ' +
      'status across plants and its "at discharge port" bucket is a pipeline stage rather than a berth. ' +
      'The two lists genuinely differ - measured 11 Sep 2026, JPS had 4 vessels alongside while KLIP ' +
      'showed 12 as berthed or unloading, overlapping on only 2. THERE IS NO JOIN KEY between the ' +
      'systems today, so never merge or reconcile the two lists: say which system a figure came from ' +
      'and stop there.',
    `Returns at most ${CAP} vessels.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (!jettyConfigured()) {
      throw capabilityUnavailable(
        'Jetty Planning System data',
        'This gateway has no JPS connection configured. That is a deployment gap, NOT a statement that ' +
          'no vessel is alongside - check the JPS application directly.',
      );
    }

    const calls: JettyCallRecord[] = [];

    // Fetched together: the board is meaningless without knowing whether its cargo
    // numbers are live, and asking for one without the other invites quoting tonnage
    // with no idea how old it is.
    const [rows, progress, health] = await Promise.all([
      jettyGet<AtBerthRow[]>(jettyRoutes.atBerth.path, {}, calls),
      jettyGet<{ summaries?: CargoSummary[] }>(jettyRoutes.atBerthCargoProgress.path, {}, calls),
      jettyGet<AtgHealth>(jettyRoutes.atgSyncHealth.path, {}, calls),
    ]);

    const all = Array.isArray(rows) ? rows : [];
    const summaries = new Map<string, CargoSummary>();
    for (const s of progress?.summaries ?? []) {
      if (s.operationId !== undefined) summaries.set(String(s.operationId), s);
    }

    const matched = all.filter(
      (r) => loosely(r.vesselName, params.vessel_name) && loosely(r.jettyName, params.jetty_name),
    );

    const now = Date.now();
    const vessels = matched.slice(0, params.limit).map((r) => {
      const cargo = r.id === undefined ? undefined : summaries.get(String(r.id));
      // The one derived figure in this tool, and it is a subtraction between two fields
      // of the same row rather than a KPI. JPS's own turnaround metric is TB to cast-off
      // per voyage, deduped by plan - a different thing, and not this.
      const alongsideSince = r.tbAt ?? r.dockingStartTime;
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
        cargo_moved: cargo?.movedQty ?? null,
        cargo_total: cargo?.totalQty ?? null,
        completion_percent: r.completionPercent ?? null,
        // The ladder, reported as JPS holds it. Nulls are unrecorded, not zero.
        eta: toWibIso(r.eta ?? null),
        arrived_at: toWibIso(r.ta ?? null),
        etb: toWibIso(r.etb ?? null),
        berthed_at: toWibIso(alongsideSince ?? null),
        nor_tendered_at: toWibIso(r.norTenderedAt ?? null),
        nor_accepted_at: toWibIso(r.norAcceptedAt ?? null),
        laytime_from: toWibIso(r.demurrageLiabilityFromAt ?? null),
        estimated_completion: toWibIso(r.estimatedCompletionTime ?? null),
        operations_completed_at: toWibIso(r.operationsCompletedAt ?? r.actualCompletionTime ?? null),
        alongside_hours: hoursBetween(alongsideSince, now),
        exception_status: r.exceptionStatus ?? null,
      };
    });

    const stale = Number(health?.staleCount ?? 0);
    const data: Record<string, unknown> = {
      vessels,
      vessels_alongside: all.length,
      rows_shown: vessels.length,
      atg_sync: {
        sources_enabled: health?.totalEnabled ?? null,
        stale_sources: health?.staleCount ?? null,
        all_healthy: health?.allHealthy ?? null,
        checked_at: toWibIso(health?.checkedAt ?? null),
      },
      cargo_trust_note:
        stale > 0
          ? `${stale} ATG source(s) have not synced within the last hour, so cargo_moved may have ` +
            'stopped advancing while loading continued. Quote tonnage from this result with that ' +
            'caveat, or check the JPS Tank Farm page before reporting it.'
          : 'All enabled ATG sources synced within the last hour, so the cargo figures are current.',
      computed_here:
        'alongside_hours only, as the elapsed time since berthing. Everything else is JPS\'s own field. ' +
        'This is NOT the turnaround metric: JPS defines turnaround as berthing to cast-off per voyage, ' +
        'deduped by shipment plan, and that comes from its dashboard endpoints.',
      milestone_note:
        'A null timestamp means the milestone is not recorded in JPS, not that the event did not ' +
        'happen. NOR accepted is what usually starts laytime; laytime_from is the demurrage liability ' +
        'instant JPS holds.',
    };

    if (vessels.length === 0) {
      data.empty_result_note =
        all.length === 0
          ? 'No vessels are alongside at this port right now. This is a real empty result - the board ' +
            'was read successfully.'
          : 'No vessel matched the filter, though ' +
            `${all.length} are alongside. Check the vessel or jetty spelling.`;
    }

    return {
      data,
      // JPS quantities carry their own metric code per row (si_quantity_unit), so there
      // is no single unit for the payload and claiming one would be wrong.
      units: null,
      rowCount: vessels.length,
      truncated: false,
      asOf: new Date(),
      system: 'jetty',
      // Structurally identical to KLIP's CallRecord. Reused rather than renamed, because
      // renaming the field would touch every KLIP tool for no behavioural gain.
      klipCalls: calls,
    };
  },
};

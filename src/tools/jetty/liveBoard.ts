/**
 * jetty_live_board - the JPS Live Ops dashboard's three LIVE widgets in one call:
 * "At berth now", "Waiting to berth" and "Arriving next N days".
 *
 * WHY A SECOND AT-BERTH TOOL
 *
 * jetty_at_berth reports JPS's raw fields and computes nothing. The dashboard people look
 * at derives several things in the browser - the ETC chip ("+20.5h" = 20.5 h past ETC), the
 * "Behind -21%" schedule badge, the Loading/Unloading x Pre/Ops/Post cards and the voyage
 * tiles - and a summary that reports different numbers from the screen beside it is worse
 * than none. This tool reproduces that arithmetic, read from the JPS source (Frontend
 * DashboardShell.jsx, utils/dashboardArrivalsWindow.js, utils/dashboardSailed.js and
 * Backend lib/cargo-schedule-progress.js), the same way jetty_berth_productivity replicates
 * the Management Dashboard. Every rule below names its source.
 *
 * SOURCES (all GET, all port-scoped):
 *   /operations/at-berth                    the alongside operations (one row per SI)
 *   /operations/at-berth/cargo-progress     moved/SI qty, gauge source, schedule comparison
 *   /shipment-plans                         NO params, as the dashboard calls it - a date
 *                                           window would hide overdue ETAs
 *   /operations?status=SAILED&cast_off_from the Sailed tile (72 h lookback)
 *
 * TWO HONEST APPROXIMATIONS, both labelled in the output:
 *   - phase (Pre/Ops/Post) is taken from the operation STATUS. The dashboard refines it with
 *     per-operation sub-process and activity calls this gateway does not make, so an
 *     operation whose first activity is logged while still DOCKED shows Pre here, Ops there.
 *   - waiting-to-berth days is TA to TB (alongside) or TA to now (waiting). Present on the
 *     production board; not in the source revision this was read from.
 */
import { z } from 'zod';
import { jettyRoutes } from './../../adapters/jetty/routes.js';
import { jettyGet, type JettyCallRecord } from './../../adapters/jetty/session.js';
import { jettyConfigured } from './../../adapters/jetty/client.js';
import { capabilityUnavailable } from './../../core/errors.js';
import { toWibIso } from './../../adapters/klip/normalize.js';
import { describe, type ToolDefinition, type ToolOutcome } from './../klip/types.js';

const CAP = 40;
const HOUR = 3_600_000;

const inputShape = {
  arrivals_window_days: z
    .union([z.literal(3), z.literal(7), z.literal(14)])
    .default(3)
    .describe('Window for "Arriving next N days": 3 (the dashboard default), 7 or 14.'),
  include: z
    .array(z.enum(['at_berth', 'waiting', 'arriving']))
    .default(['at_berth', 'waiting', 'arriving'])
    .describe('Which widgets to return. Default all three.'),
};

interface AtBerthRow {
  id?: string | number;
  shipmentPlanId?: string | number | null;
  jettyOperationCode?: string;
  vesselName?: string;
  jettyName?: string;
  purpose?: string;
  status?: string;
  commodityDisplay?: string;
  commodityShortDisplay?: string;
  commodity?: string;
  cargoSiQty?: number | string;
  cargoSiMetricCode?: string;
  ta?: string;
  tbAt?: string;
  dockingStartTime?: string;
  estimatedCompletionTime?: string;
  operationsCompletedAt?: string;
  norAcceptedAt?: string;
}

interface CargoSummary {
  connected?: boolean;
  source?: string;
  movedQty?: number;
  siQty?: number;
  totalQty?: number;
  siMetric?: string;
  completionPercent?: number;
  isLive?: boolean;
  evaluable?: boolean;
  isBehindSchedule?: boolean;
  scheduleGapPercent?: number;
  plannedPercent?: number;
  actualPercent?: number;
}

interface PlanRow {
  id?: number;
  vesselName?: string;
  vesselCapacity?: number | null;
  jettyName?: string | null;
  eta?: string | null;
  ta?: string | null;
  etb?: string | null;
  tb?: string | null;
  sailedAt?: string | null;
  castOffAt?: string | null;
  actualCompletionTime?: string | null;
  purposeCode?: string | null;
  voyageNo?: string | null;
  agentName?: string | null;
  approvalStatus?: string | null;
  shippingInstructions?: Array<{ breakdown?: Array<{ commodityName?: string | null; commodityShortName?: string | null; qty?: number; metricCode?: string | null }> }>;
}

interface SailedRow { id?: string | number; shipmentPlanId?: string | number | null; status?: string; castOffAt?: string; actualCompletionTime?: string; sailedAt?: string }

const ms = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** utils/dashboardPageUtils.js formatDurationHours: <1h minutes, >=48h days, else hours. */
function duration(hours: number | null): string | null {
  if (hours === null || hours < 0) return null;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours >= 48) return `${(hours / 24).toFixed(1)}d`;
  return `${hours.toFixed(1)}h`;
}

/** Short commodity labels across every SI breakdown line of a plan, as planCommodityShortLabels. */
function planCommodities(p: PlanRow | undefined): string | null {
  if (p === undefined) return null;
  const seen: string[] = [];
  for (const si of p.shippingInstructions ?? []) {
    for (const b of si.breakdown ?? []) {
      const label = (b.commodityShortName || b.commodityName || '').trim();
      if (label !== '' && !seen.includes(label)) seen.push(label);
    }
  }
  return seen.length ? seen.join(' · ') : null;
}

/** Sum of SI breakdown quantities in MT, for comparison with the vessel capacity the board shows. */
function planSiQtyMt(p: PlanRow): number | null {
  let total = 0;
  let any = false;
  for (const si of p.shippingInstructions ?? []) {
    for (const b of si.breakdown ?? []) {
      if ((b.metricCode ?? '').toUpperCase() === 'MT' && typeof b.qty === 'number') { total += b.qty; any = true; }
    }
  }
  return any ? round1(total) : null;
}

/** Status-based phase (see header). SIGNOFF_* are not counted in the phase cards. */
function phaseOf(status: string | undefined): 'Pre' | 'Ops' | 'Post' | null {
  if (status === 'SIGNOFF_REQUESTED' || status === 'SIGNOFF_APPROVED') return null;
  if (status === 'POST_OPS') return 'Post';
  if (status === 'IN_PROGRESS') return 'Ops';
  return 'Pre';
}

export const jettyLiveBoard: ToolDefinition<typeof inputShape> = {
  name: 'jetty_live_board',
  title: 'JPS live board: at berth, waiting, arriving',
  cap: CAP,
  description: describe(
    'The Jetty Planning System Live Ops dashboard in ONE call, with the dashboard\'s own rules: ' +
      '(1) AT BERTH NOW - Loading/Unloading counts by phase, and per vessel: operation code, jetty, purpose, ' +
      'phase, commodity, cargo moved / SI quantity and %, gauge source (ATG/hybrid/manual), "behind schedule %" ' +
      'when JPS evaluates it, waiting-to-berth time, time alongside, the ETC chip (hours PAST ETC when late, ' +
      'hours left otherwise; "done" once operations finished) and flags such as NOR not accepted; plus the ' +
      'At-berth / Ready to sail / Pending sign-off / Sailed (72 h) tiles and a list of vessels PAST their ETC. ' +
      '(2) WAITING TO BERTH - arrived (TA) and not yet alongside, any approval status except Rejected, oldest ' +
      'first, with days waiting. (3) ARRIVING NEXT 3/7/14 DAYS - not yet arrived; an ETA already in the past ' +
      'is "overdue" and always listed. Use this for "what is happening at the jetty". Quantities in waiting ' +
      'and arriving are the VESSEL CAPACITY the dashboard shows; the SI cargo total is given beside it. ' +
      'NOT KLIP and never merged with KLIP figures.',
    `Returns at most ${CAP} rows per widget.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (!jettyConfigured()) {
      throw capabilityUnavailable('Jetty Planning System live board', 'This gateway has no JPS connection configured - check the JPS dashboard directly.');
    }
    const calls: JettyCallRecord[] = [];
    const want = new Set(params.include);
    const now = Date.now();
    const sailedSince = new Date(now - 72 * HOUR).toISOString();

    const [rows, progress, plans, sailed] = await Promise.all([
      want.has('at_berth') ? jettyGet<AtBerthRow[]>(jettyRoutes.atBerth.path, {}, calls) : Promise.resolve([] as AtBerthRow[]),
      want.has('at_berth') ? jettyGet<{ summaries?: Record<string, CargoSummary | null> | CargoSummary[] }>(jettyRoutes.atBerthCargoProgress.path, {}, calls) : Promise.resolve(undefined),
      jettyGet<PlanRow[]>(jettyRoutes.shipmentPlans.path, {}, calls),
      want.has('at_berth')
        ? jettyGet<SailedRow[]>(jettyRoutes.operations.path, { [jettyRoutes.operations.params.status]: 'SAILED', [jettyRoutes.operations.params.castOffFrom]: sailedSince }, calls)
        : Promise.resolve([] as SailedRow[]),
    ]);

    const planList = Array.isArray(plans) ? plans : [];
    const planById = new Map(planList.map((p) => [String(p.id), p]));
    const data: Record<string, unknown> = { as_of_note: 'Live board, computed at the moment of this call.' };
    let rowCount = 0;
    let truncated = false;

    // ------------------------------------------------------------- at berth now
    if (want.has('at_berth')) {
      const all = Array.isArray(rows) ? rows : [];
      const summaries = new Map<string, CargoSummary>();
      const raw = progress?.summaries;
      if (Array.isArray(raw)) for (const s of raw as Array<CargoSummary & { operationId?: string | number }>) { if (s && s.operationId !== undefined) summaries.set(String(s.operationId), s); }
      else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) { if (v && typeof v === 'object') summaries.set(k, v); }

      const vessels = all.map((r) => {
        const cargo = r.id === undefined ? undefined : summaries.get(String(r.id));
        const plan = r.shipmentPlanId === null || r.shipmentPlanId === undefined ? undefined : planById.get(String(r.shipmentPlanId));
        const alongsideFrom = ms(r.tbAt ?? r.dockingStartTime);
        const ta = ms(r.ta ?? plan?.ta ?? null);
        const etc = ms(r.estimatedCompletionTime);
        // DashboardShell.jsx etcState: done / over / soon (<12 h) / ok / none.
        const opsFinished = r.status === 'SIGNOFF_REQUESTED' || r.status === 'SIGNOFF_APPROVED' || !!r.operationsCompletedAt;
        const etcDeltaH = etc === null ? null : (etc - now) / HOUR;
        const etcState = etc === null ? 'none' : opsFinished ? 'done' : (etcDeltaH as number) < 0 ? 'over' : (etcDeltaH as number) < 12 ? 'soon' : 'ok';
        const flags: string[] = [];
        if (!r.norAcceptedAt) flags.push('NOR not accepted');
        if (r.status === 'SIGNOFF_REQUESTED') flags.push('Pending sign-off');
        if (r.status === 'SIGNOFF_APPROVED') flags.push('Ready to sail');
        const connected = cargo?.connected === true;
        const siQty = cargo?.siQty ?? cargo?.totalQty ?? null;
        return {
          vessel_name: r.vesselName ?? null,
          operation_code: r.jettyOperationCode ?? null,
          jetty: r.jettyName ?? null,
          purpose: r.purpose ?? null,
          status: r.status ?? null,
          phase: phaseOf(r.status),
          commodity: (r.commodityShortDisplay && r.commodityShortDisplay !== r.commodityDisplay ? r.commodityShortDisplay : null) ?? planCommodities(plan) ?? r.commodityDisplay ?? r.commodity ?? null,
          cargo_moved: connected ? cargo?.movedQty ?? null : null,
          cargo_si_qty: connected ? siQty : null,
          cargo_unit: cargo?.siMetric ?? r.cargoSiMetricCode ?? null,
          cargo_percent: connected ? cargo?.completionPercent ?? null : null,
          gauge_source: cargo?.source ?? null,
          gauge_live: cargo?.isLive ?? null,
          behind_schedule_percent: cargo?.evaluable && cargo.isBehindSchedule ? cargo.scheduleGapPercent ?? null : null,
          waiting_to_berth_days: ta !== null && alongsideFrom !== null && alongsideFrom >= ta ? round1((alongsideFrom - ta) / (24 * HOUR)) : null,
          alongside_hours: alongsideFrom === null ? null : round1((now - alongsideFrom) / HOUR),
          alongside: alongsideFrom === null ? null : duration((now - alongsideFrom) / HOUR),
          etc: toWibIso(r.estimatedCompletionTime ?? null),
          etc_state: etcState,
          hours_past_etc: etcState === 'over' ? round1(-(etcDeltaH as number)) : null,
          hours_to_etc: etcState === 'soon' || etcState === 'ok' ? round1(etcDeltaH as number) : null,
          etc_chip: etcState === 'over' ? `+${duration(-(etcDeltaH as number))}` : etcState === 'done' ? 'Ops done' : etcState === 'none' ? 'No ETC' : duration(etcDeltaH as number),
          flags,
          voyage_key: r.shipmentPlanId !== null && r.shipmentPlanId !== undefined ? `p${r.shipmentPlanId}` : `o${r.id}`,
          plan_rejected: plan?.approvalStatus === 'Rejected',
        };
      }).sort((a, b) => (b.alongside_hours ?? -1) - (a.alongside_hours ?? -1));

      // DashboardShell.jsx cards: rows by purpose x phase (not deduplicated, as on the board).
      const cards = { loading: { total: 0, pre: 0, ops: 0, post: 0 }, unloading: { total: 0, pre: 0, ops: 0, post: 0 } };
      for (const v of vessels) {
        const side = /unload/i.test(v.purpose ?? '') ? cards.unloading : /load/i.test(v.purpose ?? '') ? cards.loading : null;
        if (side === null || v.phase === null) continue;
        side.total++;
        side[v.phase.toLowerCase() as 'pre' | 'ops' | 'post']++;
      }
      // Footer tiles: unique voyages, rejected plans skipped; Sailed = cast off in the last 72 h, deduped by plan.
      const voyages = (statuses: string[]) => new Set(vessels.filter((v) => !v.plan_rejected && statuses.includes(v.status ?? '')).map((v) => v.voyage_key)).size;
      const sailedRows = (Array.isArray(sailed) ? sailed : []).filter((s) => {
        const off = ms(s.castOffAt ?? s.actualCompletionTime ?? s.sailedAt ?? null);
        return s.status === 'SAILED' && off !== null && off >= now - 72 * HOUR;
      });
      const sailedVoyages = new Set(sailedRows.map((s) => (s.shipmentPlanId !== null && s.shipmentPlanId !== undefined ? `p${s.shipmentPlanId}` : `o${s.id}`))).size;

      const shown = vessels.slice(0, CAP).map(({ voyage_key, plan_rejected, ...v }) => v);
      truncated = truncated || vessels.length > CAP;
      rowCount += shown.length;
      data.at_berth = {
        cards,
        tiles: {
          at_berth: voyages(['DOCKED', 'IN_PROGRESS', 'POST_OPS', 'SIGNOFF_REQUESTED']),
          ready_to_sail: voyages(['SIGNOFF_APPROVED']),
          pending_sign_off: voyages(['SIGNOFF_REQUESTED']),
          sailed_last_72h: sailedVoyages,
        },
        past_etc: shown.filter((v) => v.etc_state === 'over').sort((a, b) => (b.hours_past_etc ?? 0) - (a.hours_past_etc ?? 0))
          .map((v) => ({ vessel_name: v.vessel_name, jetty: v.jetty, hours_past_etc: v.hours_past_etc, etc_chip: v.etc_chip, cargo_percent: v.cargo_percent })),
        vessels: shown,
        phase_basis: 'Phase is from the operation status (IN_PROGRESS = Ops, POST_OPS = Post, otherwise Pre); the dashboard can show Ops earlier, from logged activities.',
      };
    }

    const notRejected = (p: PlanRow) => p.approvalStatus !== 'Rejected';
    const planOut = (p: PlanRow) => ({
      vessel_name: p.vesselName ?? null,
      agent: p.agentName ?? null,
      voyage_no: p.voyageNo ?? null,
      jetty: p.jettyName ?? null,
      purpose: p.purposeCode ?? null,
      commodity: planCommodities(p),
      vessel_capacity: p.vesselCapacity ?? null,
      si_qty_mt: planSiQtyMt(p),
      status: p.approvalStatus ?? null,
    });

    // ---------------------------------------------------------- waiting to berth
    if (want.has('waiting')) {
      // dashboardArrivalsWindow.js isWaitingToBerth: TA set, no TB, not sailed; not Rejected.
      const waiting = planList
        .filter((p) => notRejected(p) && ms(p.ta) !== null && ms(p.tb) === null && ms(p.sailedAt) === null)
        .sort((a, b) => (ms(a.ta) ?? 0) - (ms(b.ta) ?? 0))
        .map((p) => ({ ...planOut(p), ta: toWibIso(p.ta ?? null), etb: toWibIso(p.etb ?? null), waiting_days: round1((now - (ms(p.ta) as number)) / (24 * HOUR)) }));
      truncated = truncated || waiting.length > CAP;
      rowCount += Math.min(waiting.length, CAP);
      data.waiting_to_berth = { count: waiting.length, vessels: waiting.slice(0, CAP) };
    }

    // ------------------------------------------------------------ arriving next N
    if (want.has('arriving')) {
      // dashboardArrivalsWindow.js evaluateArrivalPlan: not arrived; ETA in the past = overdue
      // (always listed) or ETA within the window; no ETA -> ETB within [now, now + window].
      const windowMs = params.arrivals_window_days * 24 * HOUR;
      const arriving: Array<ReturnType<typeof planOut> & { eta: string | null; etb: string | null; overdue: boolean; in_hours: number; due: string | null }> = [];
      for (const p of planList) {
        if (!notRejected(p) || ms(p.ta) !== null || ms(p.tb) !== null || ms(p.sailedAt) !== null) continue;
        const eta = ms(p.eta);
        const etb = ms(p.etb);
        let inHours: number | null = null;
        let overdue = false;
        if (eta !== null) {
          if (eta < now || eta <= now + windowMs) { inHours = (eta - now) / HOUR; overdue = eta < now; }
        } else if (etb !== null && etb >= now && etb <= now + windowMs) {
          inHours = (etb - now) / HOUR;
        }
        if (inHours === null) continue;
        arriving.push({ ...planOut(p), eta: toWibIso(p.eta ?? null), etb: toWibIso(p.etb ?? null), overdue, in_hours: round1(inHours), due: overdue ? 'overdue' : duration(inHours) });
      }
      arriving.sort((a, b) => a.in_hours - b.in_hours);
      // The dashboard lists every overdue ETA however old, most overdue first, and scrolls. Under
      // the cap, stale plans that never got a TA would crowd out the vessels actually due in
      // the window, so the cap drops the MOST overdue first and says how many it left out.
      const upcoming = arriving.filter((a) => !a.overdue);
      const overdueRows = arriving.filter((a) => a.overdue);
      const overdueKept = overdueRows.slice(Math.max(0, overdueRows.length - Math.max(0, CAP - upcoming.length)));
      const shownArriving = [...overdueKept, ...upcoming].slice(0, CAP);
      truncated = truncated || arriving.length > CAP;
      rowCount += shownArriving.length;
      data.arriving = {
        window_days: params.arrivals_window_days,
        count: arriving.length,
        overdue: overdueRows.length,
        overdue_left_out: overdueRows.length - overdueKept.length,
        vessels: shownArriving,
      };
    }

    data.computed_here =
      'The dashboard\'s browser-side rules, reproduced: ETC chip and state, behind-schedule %, phase cards, voyage tiles, waiting and arriving windows. ' +
      'Phase is status-based and waiting days are TA-based (see phase_basis). Quantities in waiting/arriving are vessel capacity, as the dashboard shows; si_qty_mt is the shipping-instruction total.';

    return { data, units: null, rowCount, truncated, asOf: new Date(now), system: 'jetty', klipCalls: calls };
  },
};

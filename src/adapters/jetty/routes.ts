/**
 * Jetty Planning System (JPS) route contracts — Phase 1, read-only.
 *
 * EVERY ENTRY HERE WAS PROBED AGAINST STAGING ON 11 SEP 2026, not copied from the
 * Technical Documentation. That ordering is the main lesson from the KLIP connector:
 * there, thirteen routes were written from assumptions, all thirteen were wrong in some
 * detail, and finding out cost weeks and two false defect reports. The TechDoc is
 * excellent and first-party, but a document describes intent and a probe describes
 * behaviour, and only the second one is what the connector will meet at runtime.
 *
 * READ-ONLY BY CONSTRUCTION. There is deliberately no `method` field on JettyRoute and
 * no way to express one. The adapter's client issues GET and nothing else, so a
 * mutation is not something this layer refuses at runtime - it is something it cannot
 * describe. That matters more here than it did for KLIP: JPS is the operational system
 * of record, and its API can approve a plan, sign off an operation and record a cast-off
 * that marks a vessel SAILED.
 *
 * It matters more again because of the credential. The staging service account (`MCP`,
 * id 32, email svc-mcp@energi-up.com) holds the `JPS Full Access` system role: measured
 * on 11 Sep 2026, 28 of its 31 pages carry edit and delete and 29 carry approve, with
 * only `cargo-movement` view-only. Jerry's decision was to proceed on staging and create
 * a read-only role for production. So on staging this file is the only thing standing
 * between a model and a berth operation, and it is written to be exactly that.
 *
 * PRODUCTION BLOCKER: a `JPS Read Only` role (canView only, no admin, no e2e-console)
 * assigned to the service account in place of Full Access.
 *
 * THREE CONTRACT FACTS THAT DIFFER FROM KLIP, ALL MEASURED:
 *
 *   1. Envelopes are MIXED. Some endpoints return a bare JSON array, others a plain
 *      object. There is no consistent `{ success, data }` wrapper as KLIP has, so each
 *      route states its own shape and `rowsPath: ''` means "the body is the array".
 *
 *   2. Port scope is a HEADER, except where it is not. Nearly everything takes
 *      `x-port-id`; /tank-gauging/latest rejects that and requires `portId` as a QUERY
 *      parameter - it answered 400 "portId is required" until the query form was used.
 *
 *   3. It is fast. 17-874 ms across everything probed, against KLIP's 790 ms per row.
 *      No page-size or timeout engineering is needed, and the default timeout is ample.
 *
 * One thing NOT yet established: whether `x-port-id` is actually enforced. Staging has a
 * single port (BONTANG, id 1) and a single-port account, so omitting the header changed
 * nothing - which is indistinguishable from a correct default. The header is sent
 * regardless, and this needs re-testing the moment a second port exists.
 */

/**
 * A read-only JPS endpoint.
 *
 * No `method`: see the header. Adding one would be the first step toward a write
 * surface, so it is absent rather than defaulted.
 */
export interface JettyRoute {
  /** Path relative to the API base, e.g. "/operations/at-berth". */
  path: string;
  /** Query parameter names as JPS actually spells them. */
  params: {
    startDate?: string;
    endDate?: string;
    status?: string;
    purpose?: string;
    jettyId?: string;
    signoffRequested?: string;
    /** Only /tank-gauging/latest: port arrives as a query param, not the header. */
    portId?: string;
    purposes?: string;
    commodityIds?: string;
  };
  /**
   * Where the rows live. '' means the response body IS the array; a dotted path means
   * the array sits under it; null means the response is a single object, not rows.
   */
  rowsPath: string | null;
  /** True when port scope travels as the x-port-id header (the usual case). */
  portHeader: boolean;
  verifiedOn: string;
  /** Observed response time on staging, to catch a regression later. */
  observedMs: number;
  notes: string;
}

export const jettyRoutes = {
  // ---------------------------------------------------------------- live operations
  atBerth: {
    path: '/operations/at-berth',
    params: {},
    rowsPath: '',
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 97,
    notes:
      'Bare array of alongside operations (status not SAILED, TB set) - the Live Ops board. Rows are ' +
      'camelCase and carry the whole milestone ladder: eta, ta, etb, pob, sob, dockingStartTime, ' +
      'estimatedCompletionTime, actualCompletionTime, operationsCompletedAt, norTenderedAt, ' +
      'norAcceptedAt, tbAt, demurrageLiabilityFromAt, castOffAt, sailedAt, plus completionPercent and ' +
      'the exception fields. 4 rows on staging.',
  },

  atBerthCargoProgress: {
    path: '/operations/at-berth/cargo-progress',
    params: {},
    rowsPath: 'summaries',
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 874,
    notes:
      'Object with a `summaries` array - live ATG moved-vs-total per alongside operation. The slowest ' +
      'endpoint probed, and still under a second.',
  },

  operations: {
    path: '/operations',
    params: {
      startDate: 'start_date',
      endDate: 'end_date',
      status: 'status',
      purpose: 'purpose',
      jettyId: 'jetty_id',
      signoffRequested: 'signoff_requested',
    },
    rowsPath: '',
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 60,
    notes:
      'Bare array. Per the TechDoc the date filter is an ETA window over COALESCE(plan.eta, ' +
      'created_at), NOT an execution-date window - so a date range here selects operations whose PLAN ' +
      'was due in it, which is a different question from what happened in it. Not yet independently ' +
      'verified; verify before reporting anything date-bounded.',
  },

  // ---------------------------------------------------------------- allocation
  allocationOverview: {
    path: '/allocation/overview',
    params: {},
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 65,
    notes:
      'Object { queue, berths, scheduleQueue } - live berth occupancy feeding the schematic and the ' +
      'occupancy KPI.',
  },

  allocationPlanOverview: {
    path: '/allocation/plan-overview',
    params: {},
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 58,
    notes:
      'Object with the SAME top-level keys as /allocation/overview { queue, berths, scheduleQueue }, ' +
      'though the TechDoc describes it as the planning-timeline Gantt source. Whether the CONTENTS ' +
      'differ is unverified - identical keys are exactly the trap that let a KLIP tool answer one ' +
      'page\'s question from another page\'s data. Establish the difference before using either.',
  },

  shipmentPlans: {
    path: '/shipment-plans',
    params: { startDate: 'start_date', endDate: 'end_date' },
    rowsPath: '',
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 70,
    notes:
      'Bare array of plans in an ETA window, with SI children and cargo breakdown. Rows carry id, ' +
      'portId, planReference and the vessel/timeline fields.',
  },

  // ---------------------------------------------------------------- KPI engines
  slotOccupancy: {
    path: '/dashboard-v2/slot-occupancy',
    params: { startDate: 'start_date', endDate: 'end_date', purposes: 'purposes', commodityIds: 'commodity_ids' },
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 48,
    notes:
      'Object { mode, usedSlots, totalSlots, pct, dayCount, overCapacity, items }. `mode` IS THE TIME ' +
      'BASIS and must be reported: a single-day range returns a snapshot (live if today, else ' +
      'end-of-day) while a multi-day range returns a per-day average. KLIP made us infer the basis; ' +
      'JPS states it, so there is no excuse for mixing them.',
  },

  slaAtRisk: {
    path: '/dashboard-v2/sla-at-risk',
    params: { startDate: 'start_date', endDate: 'end_date', purposes: 'purposes', commodityIds: 'commodity_ids' },
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 78,
    notes:
      'Object { mode, count, overHoursSum, dayCount, items } - past-ETC count and overdue hours. Same ' +
      'snapshot-versus-average duality in `mode`.',
  },

  pipelineActuals: {
    path: '/dashboard-v2/pipeline-actuals',
    params: { startDate: 'start_date', endDate: 'end_date', purposes: 'purposes', commodityIds: 'commodity_ids' },
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 24,
    notes:
      'Object with six stage counts - shipmentRequest, incoming, plannedBerthing, atBerth, readyToSail, ' +
      'sailed - each paired with a *Vessels list. THE STAGES ARE INDEPENDENT EVENT COUNTS BY ACTUAL ' +
      'DATE, NOT A FUNNEL: a vessel can appear in several, and the numbers do not decline across them. ' +
      'Presenting them as a conversion funnel would be a confident, wrong story.',
  },

  weeklyTrends: {
    path: '/dashboard-v2/weekly-trends',
    params: { startDate: 'start_date', endDate: 'end_date', purposes: 'purposes', commodityIds: 'commodity_ids' },
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 25,
    notes:
      'Object { totalSlots, weeks }. Segments are at most 7 days in UTC; future weeks are projections ' +
      'and the UI draws them dotted, so they must be labelled as projected rather than reported as ' +
      'measurements.',
  },

  atgSyncHealth: {
    path: '/dashboard-v2/atg-sync-health',
    params: {},
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 818,
    notes:
      'Object { staleThresholdMs, checkedAt, totalEnabled, staleCount, allHealthy, sources, ' +
      'staleSources }. A stale ATG source means cargo progress is not being updated, so this is a ' +
      'data-trust signal and belongs beside any live cargo figure.',
  },

  // ---------------------------------------------------------------- reference data
  siLookups: {
    path: '/si-lookups',
    params: {},
    rowsPath: null,
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 41,
    notes:
      'Object { commodities, tradeTerms, purposes, shippers, loadingPorts, surveyors, agents, jetties, ' +
      'metrics } - every vocabulary in one call. This is the klip_reference analogue and the defence ' +
      'against the failure that hurt most on KLIP: a filter value the upstream does not recognise, ' +
      'answered with zero rows and no error. Resolve names here before filtering.',
  },

  jetties: {
    path: '/jetties',
    params: {},
    rowsPath: '',
    portHeader: true,
    verifiedOn: '2026-09-11',
    observedMs: 17,
    notes: 'Bare array, 8 jetties on staging: slots, length, max draft, max DWT, allowed commodities, status.',
  },

  ports: {
    path: '/ports',
    params: {},
    rowsPath: '',
    portHeader: false,
    verifiedOn: '2026-09-11',
    observedMs: 820,
    notes:
      'Bare array. ONE port on staging: BONTANG, id 1. Every user is assigned it, which is why port ' +
      'scope could not be tested properly - see the header note.',
  },

  tankLatest: {
    path: '/tank-gauging/latest',
    params: { portId: 'portId' },
    rowsPath: '',
    portHeader: false,
    verifiedOn: '2026-09-11',
    observedMs: 41,
    notes:
      'Bare array, 60 tanks. THE ODD ONE OUT: it rejects the x-port-id header and returns 400 "portId ' +
      'is required" until port arrives as a QUERY parameter. Rows: tankId, code, name, productName, ' +
      'levelMm, temperatureC, observedDensityKgM3, totalObservedVolume, totalMass, flowRateTph, ' +
      'statusText, levelMovement.',
  },
} as const satisfies Record<string, JettyRoute>;

export type JettyRouteName = keyof typeof jettyRoutes;

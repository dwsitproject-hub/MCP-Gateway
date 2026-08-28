/**
 * ===================================================================
 * TSD APPENDIX A - VERIFIED KLIP ROUTE MAP
 * ===================================================================
 *
 * This file is the single source of truth for every KLIP path, query parameter
 * name, date format and enum value the adapter depends on. It exists so that the
 * P1 route-reconciliation output lands in ONE place instead of being scattered
 * through eight tool handlers.
 *
 *   !!  EVERY entry below is currently UNVERIFIED (verified: false).  !!
 *   !!  Stage 4 is gated on Checkpoint 0.4: run `npm run cli -- routes:verify`  !!
 *   !!  against KLIP staging, then set verified/verifiedBy/verifiedOn per row.  !!
 *
 * `assertVerified()` is called at boot when KLIP_ENV=production, so an
 * unreconciled contract cannot reach production by accident.
 *
 * Review findings that added fields here:
 *   H5  maxLimit - KLIP's accepted page size is an assumption until measured.
 *       If it caps at 100, a 1000-row PAGE_SIZE silently becomes 100 requests.
 *   H4  statusValues / incotermValues - the canonical enum sets. The documents
 *       mix languages and casings (ACTIVE / COMPLETED / Closed / Batal), and an
 *       unmapped value must be excluded with a note, never defaulted.
 */

export interface RouteContract {
  /** Path relative to KLIP_BASE_URL, e.g. "/contracts". */
  path: string;
  /** Query parameter names as KLIP actually spells them. */
  params: {
    page?: string;
    limit?: string;
    plant?: string;
    supplier?: string;
    product?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
    contractId?: string;
    stoNumber?: string;
    vesselName?: string;
    shipmentId?: string;
    location?: string;
    /** KLIP spells this camelCase; transport_mode is silently ignored. */
    transportMode?: string;
    /** Free-text match. Honoured on /contracts and on the aggregate endpoint. */
    search?: string;
    /**
     * Incoterm filter. KLIP spells it PLURAL and comma-separated on both endpoints
     * that support it. Added to /contracts on 27 Aug 2026.
     */
    incoterm?: string;
    /**
     * The gate on /contracts/late-performance/*. Only `filtered` enables the other
     * filters; anything else - including any value we might invent - leaves them parsed
     * and skipped, and the endpoint answers the unfiltered YTD question instead.
     */
    scope?: string;
  };
  /** Where the row array lives in the response body, dot-separated. */
  rowsPath: string;
  /** Where total page count lives, dot-separated. Empty when unpaginated. */
  totalPagesPath: string;
  /** Highest `limit` value KLIP accepts without error or silent clamping. */
  maxLimit: number;
  /** Quantity unit KLIP returns on this endpoint. Contracts are known to return kg. */
  quantityUnit: 'kg' | 'mt' | 'none';
  /** Date filter format expected by this endpoint. */
  dateFormat: 'iso-date' | 'iso-datetime' | 'epoch-ms' | 'unknown';
  /** Auth middleware observed on the route file. */
  authMiddleware: string;
  /** True once checked against live Swagger + route source. */
  verified: boolean;
  verifiedBy?: string;
  verifiedOn?: string;
  notes?: string;
}

const UNVERIFIED = { verified: false as const, authMiddleware: 'TBD (P1)', dateFormat: 'unknown' as const };

export const routes = {
  login: {
    path: '/auth/login',
    params: {},
    rowsPath: '',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'none (issues the token)',
    verified: true as const, verifiedBy: 'routes:verify + live probe', verifiedOn: '2026-08-21',
    notes:
      'POST {email,password}. Token at data.token; user object at data.user. JWT exp-iat = 604800s (7 days), ' +
      'NOT the 1 day the README claims. The only non-GET the adapter may emit (T-6).',
  },

  contracts: {
    // Parameter spellings probed individually on 2026-08-21 by comparing the reported
    // total with and without each one: a parameter KLIP does not know is IGNORED, not
    // rejected, so an unfiltered result set comes back looking like a filtered one.
    // Honoured: page limit plant supplier product status transportMode search dateFrom dateTo
    // IGNORED:  incoterm  transport_mode  plantCode  q  startDate/endDate  contract_date_from
    path: '/contracts',
    params: {
      page: 'page',
      limit: 'limit',
      plant: 'plant',
      supplier: 'supplier',
      product: 'product',
      status: 'status',
      // Added by KLIP on 27 Aug 2026 at our request, and NOT behind scope on this
      // endpoint. Verified: incoterms=FOB -> 688 of 6,870, incoterms=x-nonexistent -> 0.
      // Singular `incoterm` is accepted too; the plural is used for consistency with the
      // aggregate endpoint.
      incoterm: 'incoterms',
      transportMode: 'transportMode',
      search: 'search',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data.contracts',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 1000,
    // KILOGRAMS, despite the row's own unit field saying "MT". Confirmed 27 Aug 2026 and
    // reconciled against the KLIP page: a 3,500 MT contract carries quantity_ordered
    // 3500000. The `unit` field names the BUSINESS unit, not the storage unit - which is
    // exactly the kg-labelled-as-MT trap the TSD warned about, and which we wrongly told
    // the KLIP team the data contradicted.
    quantityUnit: 'kg',
    dateFormat: 'iso-date' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging 172.28.92.57:5001',
    verifiedOn: '2026-08-21',
    notes:
      'Envelope: data.contracts[] + data.pagination{total,page,limit,totalPages}. Honours limit=1000 ' +
      'un-clamped (6708 rows total). Rows carry unit="MT" but the QUANTITIES ARE KILOGRAMS - the TSD ' +
      'warning was right and our earlier note here was wrong. Numerics arrive as STRINGS, so parse ' +
      'rather than assume. ' +
      'Date filter takes bare YYYY-MM-DD and genuinely filters: dateFrom=2030-01-01 -> 0, ' +
      'dateTo=2020-12-31 -> 0, June window -> 1059. ISO-datetime, epoch-ms and DD/MM/YYYY each 400.',
  },

  contractById: {
    path: '/contracts/:id',
    params: {},
    // The record is NESTED. The envelope is
    //   data: { contract, shipments, payments, matched_by, match_count }
    // which is a different shape from the list endpoint's data.contracts[]. Reading
    // `data` here returned the wrapper and resolved every field to null against a
    // populated record - see fetchOne.
    rowsPath: 'data.contract',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'mt',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'Accepts a contract UUID, a contract number or a PO number (KLIP 35d740f). Returns matched_by ' +
      '("uuid" or "contract_or_po_number") and match_count - a PO can span several contracts under ' +
      'multi-STO, and KLIP resolves one deterministically, so match_count > 1 means the answer is one ' +
      'of several and must be reported as such. Carries linked shipments and payments INLINE. ' +
      'The two business exclusions applied to list queries are SKIPPED here, so this endpoint can ' +
      'return a contract that /contracts will never list.',
  },

  shipments: {
    path: '/shipments',
    // contractId, stoNumber, vesselName and status are NOT supported upstream - KLIP
    // ignores them and returns all 348 rows. Omitting them here routes those filters to
    // buildFilters()'s local[] fallback, which actually applies them. Declaring a
    // parameter KLIP silently discards is the worst option: the answer looks filtered.
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contractId',
      stoNumber: 'stoNumber',
      vesselName: 'vesselName',
      plant: 'plant',
      search: 'search',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data.shipments',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 500,
    quantityUnit: 'none',
    dateFormat: 'iso-date' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging 172.28.92.57:5001',
    verifiedOn: '2026-08-21',
    notes:
      'Envelope: data.shipments[] + data.summary{} + data.pagination{}. Only 348 rows exist, so the page-size ' +
      'ceiling is UNMEASURED - 500 is a safe floor, not a measurement. data.summary carries a full status ' +
      'breakdown (unplanned/preplanned/planned/atLoadingPort/sailed/atDischargePort/completed/cancelled). ' +
      'Dates take bare YYYY-MM-DD; ISO-datetime and DD/MM/YYYY each 400.',
  },

  trucking: {
    path: '/trucking',
    // contractId and status are ignored upstream (5824 rows come back regardless), so
    // they are deliberately absent and fall through to local filtering.
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contractId',
      plant: 'plant',
      location: 'location',
      search: 'search',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data.truckingOperations',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 500,
    quantityUnit: 'none',
    dateFormat: 'iso-date' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging 172.28.92.57:5001',
    verifiedOn: '2026-08-21',
    notes:
      'Envelope: data.truckingOperations[] + data.summary{} + data.pagination{}. SILENTLY CLAMPS at 500: ' +
      'limit=1000 returns 500 rows with no error, against 5824 total (review H5). data.summary.outstandingQty ' +
      'is denominated in KG (frcKg/lcoKg/totalKg) while contracts report MT - row-level unit unconfirmed.',
  },

  quality: {
    path: '/quality',
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contractId',
      shipmentId: 'shipmentId',
      location: 'location',
    },
    // Guessed to match the majority shape (data.<key>[] + data.pagination), which three
    // of the five known endpoints use. Re-probe once KLIP names the real path.
    rowsPath: 'data.quality',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 100,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'TBD (P1)',
    verified: false,
    notes:
      'NO ENDPOINT EXISTS. Confirmed by the KLIP team 27 Aug 2026: there is no /api/quality* route and no ' +
      'REST handler over quality_surveys anywhere in the codebase. Quality data is reachable only through ' +
      'the pages that render it. Nineteen probed paths returned 404 because none of them exist, not ' +
      'because the spelling was wrong. Logged as KLIP work, not a connector defect. ' +
      'NOT the same thing as /oil-loss, which is gain/loss on movements - see the oilLoss route. ' +
      'Pointing this tool at oil-loss would report one measurement under the name of another.',
  },

  /**
   * Oil loss / gain across movements. A DIFFERENT dataset from quality surveys, despite
   * the front-end presenting them near each other: this is weight reconciliation between
   * dispatch and receipt, not laboratory measurement.
   *
   * Probed 27 Aug 2026. The envelope is unlike every other endpoint here:
   *
   *   { data: [...], ytdSummary: {...}, gainSummary: {...}, dataSources: {...} }
   *
   * No `success` wrapper, and NO PAGINATION AT ALL - no page, no limit, no total. Whether
   * the server caps the row set is unmeasured, so the tool must not imply completeness.
   *
   * `dataSources` names the provenance of each quantity, which no other endpoint offers.
   */
  /**
   * Canonical filter vocabularies - the same lists KLIP's own filter UI uses. Probed
   * 27 Aug 2026. Only THREE exist: group-plants, incoterms and b2b-flags. The obvious
   * siblings (/products, /suppliers, /statuses) return 404, so those vocabularies still
   * have to be sampled from contract rows and reported as samples.
   *
   * Envelope is { success, data: { <key>: [...] } } - a bare string array, no counts.
   *
   * WORTH KNOWING: group-plants collapses the two TJ.PURA sites into one "TJ PURA",
   * which is the merge KLIP warned us not to make. /trucking's location field
   * distinguishes "EUP EDIBLE OIL TJ.PURA" from "EUP BIOMASS TJ.PURA". So the canonical
   * list is canonical for CONTRACT filtering and is NOT a plant register.
   */
  /**
   * KLIP's own contract-performance aggregates - the figures its Contract Performance
   * page renders. Aggregated across the full filtered dataset with NO pagination, which
   * is what makes them coherent where our page-bounded totals are not.
   *
   * scope=filtered IS THE SWITCH THAT TURNS THE OTHER FILTERS ON.
   *
   * Without it the endpoint answers the unfiltered YTD question and every gated filter
   * is parsed and then skipped. KLIP's source:
   *
   *   const scope = String(req.query.scope ?? 'ytd').toLowerCase();
   *   statusNorm = scope === 'filtered' ? status.trim() : '';
   *   if (scope === 'filtered' && selectedIncoterms) { ... }
   *
   * We got this wrong first time round in a way worth recording. We tested `scope` with
   * all / open / close / ytd - four values we invented - saw no effect, and reported the
   * filters as broken. The one value that matters was never tried. Guessing a parameter's
   * accepted values and concluding from their failure is not a measurement.
   *
   * Verified 27 Aug 2026 against live staging, statusCardSummary counts:
   *
   *   (none)                              233, 262, 1817, 1848
   *   plant=x-nonexistent                 233, 262, 1817, 1848   <- gate closed
   *   scope=filtered&plant=x-nonexistent    0,   0,    0,    0
   *   scope=filtered&incoterms=FOB         11,  21,    4,  164
   *   scope=filtered&incoterms=LCO         85, 125,  358,  619
   *   scope=filtered&incoterms=FOB,LCO     96, 146,  362,  783
   *
   * The multi-value row partitions exactly - 11+85=96, 21+125=146, 4+358=362,
   * 164+619=783 - which proves it selects rather than merely perturbs.
   *
   * STILL NOT WORKING: `status`. scope=filtered&status=Open leaves all four counts
   * unchanged, while plant, search and incoterms all narrow. KLIP lists it as gated and
   * its source reads statusNorm from it, so either the accepted vocabulary differs here
   * or the gate is vestigial. NOT exposed until answered - the endpoint already splits
   * open from close in its own output, so nothing is lost.
   *
   * NOT gated, working with or without scope: transportMode, dateFrom / dateTo.
   *
   * Units of totalQtyDelivery / openOutstandingQty / closeOutstandingQty are NOT
   * established and are not converted.
   */
  latePerformanceSummary: {
    path: '/contracts/late-performance/summary',
    params: {
      scope: 'scope',
      plant: 'plant',
      supplier: 'supplier',
      product: 'product',
      incoterm: 'incoterms',
      search: 'search',
      transportMode: 'transportMode',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'none',
    dateFormat: 'iso-date' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'Returns data.{scope, ytd_range, summary, onTrackSummary, statusCardSummary, distribution} - a ' +
      'summary object, not rows. Aggregated over the whole filtered set with no pagination. ' +
      'Figures follow the KLIP outstanding rules, which govern per the 24 Aug ruling; our own ' +
      'incoterm-basis calculation in klip_outstanding may differ, so the two must never be mixed in ' +
      'one answer without saying which produced which.',
  },

  filterOptionsGroupPlants: {
    path: '/contracts/filter-options/group-plants',
    params: {},
    rowsPath: 'data.groupPlants',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging',
    verifiedOn: '2026-08-27',
    notes: '14 values, names not codes: Bekasi, Bontang, Bulking Batam ... Cisadane, TJ BUTON, TJ PURA, Trading.',
  },

  filterOptionsIncoterms: {
    path: '/contracts/filter-options/incoterms',
    params: {},
    rowsPath: 'data.incoterms',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging',
    verifiedOn: '2026-08-27',
    notes:
      'SIX values: Blank, CFR, CIF, FOB, FRC, LCO. A 200-row contract sample only ever showed ' +
      'FOB/FRC/LCO, so sampling understated the domain - exactly why the canonical list matters. ' +
      'CFR and Blank are NOT classified by our outstanding-basis rules, so those contracts are ' +
      'currently excluded from outstanding totals as unknown_incoterm. Classification queried with KLIP.',
  },

  filterOptionsB2bFlags: {
    path: '/contracts/filter-options/b2b-flags',
    params: {},
    rowsPath: 'data.b2bFlags',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging',
    verifiedOn: '2026-08-27',
    notes: 'Two values: B2B, DIRECT.',
  },

  /**
   * Shipping performance - the KLIP Shipping Performance page. Planned against actual at
   * every port milestone, per shipment.
   *
   * Probed 28 Aug 2026. { success, data[] }, 370 rows, NO pagination.
   *
   * KLIP COMPUTES THE DELTAS ITSELF. loading_delta_eta_etb_days,
   * discharge_delta_etb_etc_days, total_delta_days and the ata_* variants are all
   * KLIP's arithmetic. We report those rather than subtracting timestamps ourselves,
   * for the same reason klip_outstanding stopped computing outstanding.
   *
   * FILTERS: only `plant` is applied. vessel_name, status, contract_number and limit are
   * accepted and DISCARDED - each returns all 370 rows. scope=filtered is not needed
   * here; plant narrows without it.
   *
   * COVERAGE IS THIN AND UNEVEN, which is the main thing a caller must be told:
   *   total_delta_days        137 of 370
   *   ata_total_delta_days    164 of 370
   *   loading_ata_arrival     171 of 370
   *   discharge_ata_completed  90 of 370
   * An average over these is an average over a third of the fleet, not the fleet.
   *
   * ALWAYS EMPTY on staging: freight, fuel_consumption, pump_rate, sailing_speed
   * (0 of 370) and shortage (2 of 370). The page has columns for them.
   *
   * Quantities follow the same kilogram convention as everywhere else in KLIP -
   * contract_qty 1200000 for a 1,200 MT barge cargo.
   */
  shippingPerformance: {
    path: '/shipments/performance',
    // Only plant. Sending the others would imply a control the caller does not have.
    params: { plant: 'plant' },
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'kg',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'GET /api/shipments/performance. Backs the Shipping Performance page. No pagination and no total, ' +
      'so completeness cannot be asserted. Delta fields are KLIP-computed; do not recompute from the ' +
      'ETA/ATA pairs. Milestone coverage ranges from 90 to 171 of 370 rows.',
  },

  oilLoss: {
    path: '/oil-loss',
    // No pagination parameters are advertised. Sending page/limit would imply a control
    // the caller does not have; whether they are silently ignored is unmeasured.
    params: {},
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 0,
    // UNCONFIRMED. The payload mixes units and only labels some of them:
    // gainSummary.totalGainKg is kilograms, ytdSummary.r1.totalMt is tonnes, and the
    // row-level quantity_* fields carry no suffix either way. Left as 'none' so nothing
    // is converted on a guess - a wrong choice here is a 1000x error.
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'authenticateToken (no role gate)',
    verified: false,
    notes:
      'GET /api/oil-loss, mounted at server.ts:212 with a root GET handler. Bearer token required, ' +
      'no role gate beyond authentication. Carries the contract join directly: contract_number, ' +
      'contract_ext_no, sto_number, po_number, operation_id. ' +
      'quantity_sent is PRESENT and non-null here, which contradicts KLIP-004 (0 of 6766 in ' +
      'trucking_operations.quantity_sent) - provenance and coverage queried with the KLIP team, ' +
      'so sent is not surfaced until answered. Row-level units unconfirmed.',
  },

  payments: {
    path: '/finance/payments',
    // contract_id is SNAKE_CASE here while every other endpoint uses camelCase -
    // contractId is ignored. No date filtering exists at all: dateFrom/dateTo leave the
    // total at 9011 and are not even format-validated, so they are omitted and applied
    // locally instead.
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contract_id',
      supplier: 'supplier',
      status: 'status',
      search: 'search',
    },
    rowsPath: 'data',
    totalPagesPath: 'pagination.totalPages',
    maxLimit: 500,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging 172.28.92.57:5001',
    verifiedOn: '2026-08-21',
    notes:
      'Path is /finance/payments, NOT /payments. Pagination sits at the TOP LEVEL here, not under data - ' +
      'the only endpoint of the five shaped that way. SILENTLY CLAMPS at 500 against 9011 total. ' +
      'Date filtering is UNSUPPORTED upstream and handled locally, which means a date-filtered payments ' +
      'query has to page through up to 19 pages - watch it against the latency target. ' +
      'Amounts are currency, not quantities - never run them through kgToMt.',
  },

  sapImports: {
    path: '/sap-master-v2/imports',
    // limit is IGNORED: 1, 10 and 200 all return exactly 50 rows. Sending it would
    // imply a control the caller does not have.
    params: {},
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 50,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: true as const,
    verifiedBy: 'live probe against KLIP staging 172.28.92.57:5001',
    verifiedOn: '2026-08-21',
    notes:
      'data[] directly, NO pagination envelope, and limit is IGNORED - 1, 10 and 200 all return 50 rows. ' +
      'This endpoint can surface at most 50 records, full stop; the tool must say so rather than imply ' +
      'the caller is seeing everything. Fields: id, import_date, import_timestamp, status, total_records, ' +
      'processed_records, failed_records.',
  },
} as const satisfies Record<string, RouteContract>;

export type RouteName = keyof typeof routes;

/**
 * Canonical enum values (review H4). Left deliberately broad until Appendix A is
 * filled: the adapter maps case-insensitively and treats anything not listed as a
 * data-quality exclusion rather than guessing a basis.
 */
export const enums = {
  /**
   * Observed in KLIP staging on 2026-08-21 across 200 contract rows:
   *   status         Open, Close
   *   incoterm       FOB, FRC, LCO
   *   transport_mode LAND, MIX, SEA
   *   currency       USD
   *   unit           MT
   *   contract_type  B2B, DIRECT
   *
   * Shipments and trucking use their OWN status vocabularies, taken from the
   * data.summary.status breakdown each endpoint returns:
   *   shipments  unplanned, preplanned, planned, atLoadingPort, sailed,
   *              atDischargePort, completed, cancelled
   *   trucking   unplanned, planned, inProgress, loading, inTransit,
   *              unloading, completed, cancelled
   *
   * Matching stays case-insensitive, and anything unlisted is still excluded with a
   * note rather than defaulted - a 200-row sample proves what EXISTS, not what the
   * full domain is.
   */
  zeroOutstandingStatuses: ['close', 'closed', 'batal', 'cancelled', 'canceled'],
  openStatuses: ['open', 'active', 'aktif', 'unplanned', 'planned', 'preplanned', 'inprogress'],
  completedStatuses: ['completed', 'complete', 'selesai'],
  /**
   * Incoterms whose outstanding basis is quantity SHIPPED.
   * KLIP spells these FOB and LCO; the long forms are kept so a spelling change
   * upstream does not silently reclassify a row.
   */
  shippedBasisIncoterms: ['fob', 'lco', 'loco'],
  /**
   * Incoterms whose outstanding basis is quantity RECEIVED.
   * KLIP spells Franco as FRC - confirmed by data.summary.outstandingQty on
   * /trucking, which buckets outstanding volume into frcKg and lcoKg.
   */
  receivedBasisIncoterms: ['frc', 'franco', 'cif'],
  shipmentStatuses: [
    'unplanned', 'preplanned', 'planned', 'atloadingport',
    'sailed', 'atdischargeport', 'completed', 'cancelled',
  ],
  truckingStatuses: [
    'unplanned', 'planned', 'inprogress', 'loading',
    'intransit', 'unloading', 'completed', 'cancelled',
  ],
  /** Still false: transport_mode/currency/contract_type are recorded but unused, and
   *  the quality endpoint has not been found, so its vocabulary is unknown. */
  verified: false,
} as const;

export interface VerificationGap {
  route: string;
  reason: string;
}

export function verificationGaps(): VerificationGap[] {
  const gaps: VerificationGap[] = [];
  for (const [name, route] of Object.entries(routes as Record<string, RouteContract>)) {
    if (!route.verified) gaps.push({ route: name, reason: 'route contract not reconciled against live KLIP (P1)' });
    if (route.dateFormat === 'unknown' && route.params.dateFrom !== undefined) {
      gaps.push({ route: name, reason: 'date filter format unknown' });
    }
  }
  if (!enums.verified) gaps.push({ route: '(enums)', reason: 'status / incoterm value sets not confirmed against KLIP data' });
  return gaps;
}

/**
 * Refuse to serve production data on an unreconciled contract.
 * Appendix A gates Stage 4; this makes the gate executable rather than clerical.
 */
export function assertVerified(klipEnv: 'staging' | 'production'): void {
  if (klipEnv !== 'production') return;
  const gaps = verificationGaps();
  if (gaps.length === 0) return;
  const detail = gaps.map((g) => `  - ${g.route}: ${g.reason}`).join('\n');
  console.error(
    `FATAL: refusing to start against KLIP production with an unverified route map (TSD Appendix A):\n${detail}\n` +
      `Run: npm run cli -- routes:verify --base-url <staging> and record the results in src/adapters/klip/routes.ts`,
  );
  process.exit(1);
}

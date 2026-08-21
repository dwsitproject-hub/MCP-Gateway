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
    path: '/contracts',
    params: {
      page: 'page',
      limit: 'limit',
      plant: 'plant',
      supplier: 'supplier',
      product: 'product',
      status: 'status',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data.contracts',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 1000,
    quantityUnit: 'mt',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'Envelope: data.contracts[] + data.pagination{total,page,limit,totalPages}. Honours limit=1000 ' +
      'un-clamped (6708 rows total). Rows carry unit="MT" - the TSD claim that contracts return kg is ' +
      'CONTRADICTED by the data. Numerics arrive as STRINGS. Date filter format still unmeasured.',
  },

  contractById: {
    path: '/contracts/:id',
    params: {},
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'mt',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes: 'Single-row shape not yet probed.',
  },

  shipments: {
    path: '/shipments',
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contractId',
      stoNumber: 'stoNumber',
      vesselName: 'vesselName',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data.shipments',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 500,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'Envelope: data.shipments[] + data.summary{} + data.pagination{}. Only 348 rows exist, so the page-size ' +
      'ceiling is UNMEASURED - 500 is a floor, not a measurement. data.summary carries a full status breakdown ' +
      '(unplanned/preplanned/planned/atLoadingPort/sailed/atDischargePort/completed/cancelled). Row-level ' +
      'quantity unit not yet established.',
  },

  trucking: {
    path: '/trucking',
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contractId',
      plant: 'plant',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data.truckingOperations',
    totalPagesPath: 'data.pagination.totalPages',
    maxLimit: 500,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
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
      'PATH UNKNOWN - still 404. Probed and rejected: /quality /qualities /quality-control /quality-checks ' +
      '/qc /quality/results /quality/inspections /operations/quality /quality-results /lab /inspection ' +
      '/inspections /survey /surveys /qualities/results /finance/quality /quality/reports /cargo-quality ' +
      '/product-quality. Ask the KLIP team for the real path. FFA / M&I / IV / DOBI are measurements, ' +
      'not quantities.',
  },

  payments: {
    path: '/finance/payments',
    params: {
      page: 'page',
      limit: 'limit',
      contractId: 'contractId',
      status: 'status',
      dateFrom: 'dateFrom',
      dateTo: 'dateTo',
    },
    rowsPath: 'data',
    totalPagesPath: 'pagination.totalPages',
    maxLimit: 500,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'Path is /finance/payments, NOT /payments. Pagination sits at the TOP LEVEL here, not under data - ' +
      'the only endpoint of the five shaped that way. SILENTLY CLAMPS at 500 against 9011 total. ' +
      'Amounts are currency, not quantities - never run them through kgToMt.',
  },

  sapImports: {
    path: '/sap-master-v2/imports',
    params: { limit: 'limit' },
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 50,
    quantityUnit: 'none',
    dateFormat: 'unknown' as const,
    authMiddleware: 'bearerAuth',
    verified: false,
    notes:
      'data[] directly, with NO pagination envelope at all - the 50 rows returned are whatever the server ' +
      'defaults to. Fields: id, import_date, import_timestamp, status, total_records, processed_records, ' +
      'failed_records. Whether limit is honoured is unmeasured.',
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

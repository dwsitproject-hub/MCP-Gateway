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
    ...UNVERIFIED,
    notes: 'POST. The only non-GET the adapter may emit (T-6). Confirm body shape and JWT TTL (README says 1d).',
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
    rowsPath: 'data',
    totalPagesPath: 'pagination.totalPages',
    maxLimit: 100,
    quantityUnit: 'kg',
    ...UNVERIFIED,
    notes: 'Pagination contract (page/limit + pagination.totalPages) is the one known-true shape. kg despite MT labels in the UI.',
  },

  contractById: {
    path: '/contracts/:id',
    params: {},
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 0,
    quantityUnit: 'kg',
    ...UNVERIFIED,
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
    rowsPath: 'data',
    totalPagesPath: 'pagination.totalPages',
    maxLimit: 100,
    quantityUnit: 'kg',
    ...UNVERIFIED,
    notes: 'INFERRED path - one of the four the PRD flags as unconfirmed.',
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
    rowsPath: 'data',
    totalPagesPath: 'pagination.totalPages',
    maxLimit: 100,
    quantityUnit: 'kg',
    ...UNVERIFIED,
    notes: 'INFERRED path.',
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
    rowsPath: 'data',
    totalPagesPath: 'pagination.totalPages',
    maxLimit: 100,
    quantityUnit: 'none',
    ...UNVERIFIED,
    notes: 'INFERRED path. FFA / M&I / IV / DOBI are measurements, not quantities.',
  },

  payments: {
    path: '/payments',
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
    maxLimit: 100,
    quantityUnit: 'none',
    ...UNVERIFIED,
    notes: 'INFERRED path. Amounts are IDR, not quantities - do not run them through kgToMt.',
  },

  sapImports: {
    path: '/sap-master-v2/imports',
    params: { limit: 'limit' },
    rowsPath: 'data',
    totalPagesPath: '',
    maxLimit: 50,
    quantityUnit: 'none',
    ...UNVERIFIED,
  },
} as const satisfies Record<string, RouteContract>;

export type RouteName = keyof typeof routes;

/**
 * Canonical enum values (review H4). Left deliberately broad until Appendix A is
 * filled: the adapter maps case-insensitively and treats anything not listed as a
 * data-quality exclusion rather than guessing a basis.
 */
export const enums = {
  /** Statuses whose outstanding quantity is forced to zero. */
  zeroOutstandingStatuses: ['closed', 'batal', 'cancelled', 'canceled'],
  /** Statuses recognised as live/open. */
  openStatuses: ['active', 'aktif', 'open'],
  /** Statuses recognised as finished but not cancelled. See H4: confirm whether COMPLETED zeroes. */
  completedStatuses: ['completed', 'complete', 'selesai'],
  /** Incoterms whose outstanding basis is quantity SHIPPED. */
  shippedBasisIncoterms: ['fob', 'loco'],
  /** Incoterms whose outstanding basis is quantity RECEIVED. */
  receivedBasisIncoterms: ['franco', 'cif'],
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

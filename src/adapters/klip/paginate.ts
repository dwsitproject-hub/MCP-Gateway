/**
 * Bounded page walker (TSD Section 7.3).
 *
 *   MAX_PAGES x PAGE_SIZE is a hard ceiling per tool call.
 *   Aggregates are computed over the full bounded fetch, then the top-N slice
 *   is taken - never the other way round, or totals disagree with the KLIP UI.
 *
 * Review fixes:
 *   H5  Pages 2..N are fetched CONCURRENTLY (under the shared semaphore) once
 *       page 1 reveals the total. Ten sequential round-trips cannot meet P95 <= 5 s.
 *   H5  PAGE_SIZE is clamped to the route's verified maxLimit, so a route that
 *       caps `limit` at 100 does not silently turn a 1000-row page into 100 rows
 *       and a wrong total.
 *   H4.1 The result reports coverage honestly: `fetchedRows` of `totalRows`, so a
 *       caller can refuse to publish a figure called "total" over a partial set.
 */
import { cfg } from './../../core/config.js';
import { logger } from './../../core/logger.js';
import { mapLimit } from './../../core/semaphore.js';
import { authorizedGet, type CallRecord } from './session.js';
import type { RouteContract } from './routes.js';

export interface PageWalk<T> {
  rows: T[];
  /** True when KLIP holds more pages than the bound allowed us to read. */
  truncated: boolean;
  /** Rows actually retrieved. */
  fetchedRows: number;
  /** Total rows KLIP reports matching the filter, when it tells us. */
  totalRows: number | null;
  totalPages: number | null;
  pagesFetched: number;
  calls: CallRecord[];
}

export function dig(body: unknown, path: string): unknown {
  if (path === '') return undefined;
  let cursor: unknown = body;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Extract the row array, tolerating a bare array body or a `{ data: [...] }` wrapper. */
export function extractRows<T>(body: unknown, rowsPath: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const at = dig(body, rowsPath);
  if (Array.isArray(at)) return at as T[];
  // Common alternates, in case Appendix A differs from the assumed shape.
  for (const alt of ['data', 'items', 'rows', 'results', 'data.data']) {
    const candidate = dig(body, alt);
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

function extractNumber(body: unknown, path: string, alternates: readonly string[]): number | null {
  for (const candidate of [path, ...alternates]) {
    const value = dig(body, candidate);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

// KLIP nests its pagination object under `data` on /contracts, /shipments and /trucking,
// but puts it at the top level on /finance/payments. Probed 2026-08-21. Both shapes are
// listed so a route whose explicit totalPagesPath is wrong still degrades to a search
// rather than to null - reporting "page 1 of ?" when the answer was available.
export const TOTAL_PAGES_ALTERNATES = [
  'pagination.totalPages',
  'data.pagination.totalPages',
  'meta.totalPages',
  'totalPages',
  'pagination.total_pages',
  'data.pagination.total_pages',
] as const;
export const TOTAL_ROWS_ALTERNATES = [
  'pagination.total',
  'data.pagination.total',
  'pagination.totalItems',
  'data.pagination.totalItems',
  'meta.total',
  'total',
  'totalCount',
  'pagination.totalRecords',
] as const;

export interface WalkOptions {
  route: RouteContract;
  /** Query parameters other than page/limit, already mapped to KLIP's own names. */
  filters?: Record<string, string | number | undefined>;
  /** Override the page bound for a tool that needs less than the global ceiling. */
  maxPages?: number;
  calls?: CallRecord[];
}

/**
 * Walk a paginated KLIP list endpoint up to the configured bound.
 */
export async function walk<T>(opts: WalkOptions): Promise<PageWalk<T>> {
  const { route } = opts;
  const calls = opts.calls ?? [];
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? cfg.KLIP_MAX_PAGES, cfg.KLIP_MAX_PAGES));
  const pageSize = Math.max(1, Math.min(cfg.KLIP_PAGE_SIZE, route.maxLimit > 0 ? route.maxLimit : cfg.KLIP_PAGE_SIZE));

  const pageParam = route.params.page;
  const limitParam = route.params.limit;

  const baseParams: Record<string, string | number | undefined> = { ...(opts.filters ?? {}) };
  if (limitParam !== undefined) baseParams[limitParam] = pageSize;

  // --- page 1 -------------------------------------------------------------
  const firstParams = { ...baseParams };
  if (pageParam !== undefined) firstParams[pageParam] = 1;

  const firstBody = await authorizedGet<unknown>(route.path, firstParams, calls);
  const firstRows = extractRows<T>(firstBody, route.rowsPath);

  const totalPages = extractNumber(firstBody, route.totalPagesPath, TOTAL_PAGES_ALTERNATES);
  const totalRows = extractNumber(firstBody, '', TOTAL_ROWS_ALTERNATES);

  // Unpaginated endpoint, or everything already returned.
  if (pageParam === undefined || totalPages === null || totalPages <= 1) {
    const truncated = totalRows !== null && firstRows.length < totalRows;
    return {
      rows: firstRows,
      truncated,
      fetchedRows: firstRows.length,
      totalRows,
      totalPages,
      pagesFetched: 1,
      calls,
    };
  }

  const pagesToFetch = Math.min(totalPages, maxPages);
  const truncated = totalPages > maxPages;
  if (truncated) {
    logger.warn(
      { path: route.path, totalPages, maxPages },
      'page bound reached - result will be marked truncated and totals will be reported as partial',
    );
  }

  // --- pages 2..N concurrently, order preserved --------------------------
  const remaining = Array.from({ length: pagesToFetch - 1 }, (_, i) => i + 2);
  const pages = await mapLimit(remaining, cfg.KLIP_FETCH_CONCURRENCY, async (pageNumber) => {
    const params = { ...baseParams, [pageParam]: pageNumber };
    const body = await authorizedGet<unknown>(route.path, params, calls);
    return extractRows<T>(body, route.rowsPath);
  });

  const rows = [...firstRows, ...pages.flat()];

  return {
    rows,
    truncated,
    fetchedRows: rows.length,
    totalRows,
    totalPages,
    pagesFetched: pagesToFetch,
    calls,
  };
}

/**
 * Single-object GET (e.g. /contracts/:id). Returns undefined on 404.
 *
 * This used to unwrap `data` unconditionally, which is right for a flat envelope and
 * wrong for a nested one. /api/contracts/:id returns
 *
 *   data: { contract, shipments, payments, matched_by, match_count }
 *
 * so unwrapping to `data` handed the caller the WRAPPER. Every field read then resolved
 * to null against a record that was present and populated - and the absent-record guard
 * passed, because the object had keys. The tool reported contract_id "(unknown)" with
 * every field null for a contract that search returns in full. Caught by the KLIP team
 * probing this connector on 27 Aug 2026.
 *
 * The extraction path is now the route's own, so a route whose record sits somewhere
 * other than `data` says so rather than relying on a shared assumption.
 */
export async function fetchOne<T>(
  path: string,
  extractPath = 'data',
  calls?: CallRecord[],
): Promise<T | undefined> {
  const body = await fetchEnvelope(path, calls);
  if (body === undefined) return undefined;
  if (typeof body === 'object' && !Array.isArray(body)) {
    const wrapped = dig(body, extractPath);
    if (wrapped !== undefined && wrapped !== null) return wrapped as T;
    return undefined;
  }
  return body as T;
}

/**
 * The whole response body for a single-object GET.
 *
 * /api/contracts/:id carries linked shipments and payments INLINE alongside the record,
 * plus matched_by and match_count. Fetching the envelope once and reading all of it beats
 * three more round trips for data already in hand.
 */
export async function fetchEnvelope(path: string, calls?: CallRecord[]): Promise<unknown | undefined> {
  const body = await authorizedGet<unknown>(path, {}, calls);
  if (body === undefined || body === null) return undefined;
  return body;
}

/**
 * Shared parameter plumbing for the KLIP tools.
 *
 * The important property here: a filter is only ever sent to KLIP under a name
 * routes.ts says KLIP accepts. If a route has no `plant` parameter, a plant filter
 * is applied locally AND declared as a local filter in the result, because
 * silently filtering in the gateway is a divergence from the KLIP UI and metric
 * M1 measures exactly that (review H6).
 */
import { z } from 'zod';
import type { RouteContract } from './../../adapters/klip/routes.js';

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date as YYYY-MM-DD')
  .describe('Date in YYYY-MM-DD form (Western Indonesia time).');

export function formatDateForRoute(value: string, route: RouteContract): string {
  switch (route.dateFormat) {
    case 'epoch-ms':
      return String(Date.parse(`${value}T00:00:00+07:00`));
    case 'iso-datetime':
      return `${value}T00:00:00+07:00`;
    case 'iso-date':
    case 'unknown':
    default:
      // Until Appendix A says otherwise, send the plain date - the most widely accepted form.
      return value;
  }
}

export interface FilterInput {
  plant?: string | undefined;
  supplier?: string | undefined;
  product?: string | undefined;
  status?: string | undefined;
  contract_id?: string | undefined;
  sto_number?: string | undefined;
  vessel_name?: string | undefined;
  shipment_id?: string | undefined;
  location?: string | undefined;
  date_from?: string | undefined;
  date_to?: string | undefined;
}

export interface BuiltFilters {
  /** Query parameters KLIP will receive, keyed by KLIP's own parameter names. */
  upstream: Record<string, string | number | undefined>;
  /** Filters KLIP cannot express, which the adapter must apply to the fetched rows. */
  local: Array<keyof FilterInput>;
}

const FILTER_TO_ROUTE_PARAM: Record<keyof FilterInput, keyof RouteContract['params']> = {
  plant: 'plant',
  supplier: 'supplier',
  product: 'product',
  status: 'status',
  contract_id: 'contractId',
  sto_number: 'stoNumber',
  vessel_name: 'vesselName',
  shipment_id: 'shipmentId',
  location: 'location',
  date_from: 'dateFrom',
  date_to: 'dateTo',
};

export function buildFilters(route: RouteContract, input: FilterInput): BuiltFilters {
  const upstream: Record<string, string | number | undefined> = {};
  const local: Array<keyof FilterInput> = [];

  for (const [filterKey, routeKey] of Object.entries(FILTER_TO_ROUTE_PARAM) as Array<
    [keyof FilterInput, keyof RouteContract['params']]
  >) {
    const value = input[filterKey];
    if (value === undefined || value === '') continue;

    const upstreamName = route.params[routeKey];
    if (upstreamName === undefined) {
      local.push(filterKey);
      continue;
    }

    upstream[upstreamName] =
      filterKey === 'date_from' || filterKey === 'date_to' ? formatDateForRoute(value, route) : value;
  }

  return { upstream, local };
}

/** Case-insensitive contains match, used only for filters KLIP cannot express. */
export function matchesLoosely(candidate: string | null, wanted: string | undefined): boolean {
  if (wanted === undefined || wanted === '') return true;
  if (candidate === null) return false;
  return candidate.toLowerCase().includes(wanted.trim().toLowerCase());
}

/** Aggregate the data-quality note counts across rows into one map for the envelope. */
export function countNotes(rows: ReadonlyArray<{ data_quality: readonly string[] }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    for (const note of row.data_quality) counts[note] = (counts[note] ?? 0) + 1;
  }
  return counts;
}

/**
 * Note appended to a payload when the gateway had to filter locally, so the model
 * can say so rather than implying KLIP applied the filter.
 */
export function localFilterNote(local: ReadonlyArray<keyof FilterInput>): string | undefined {
  if (local.length === 0) return undefined;
  return (
    `KLIP has no server-side filter for: ${local.join(', ')}. ` +
    'These were applied by the gateway to the rows it fetched, so counts may differ from the KLIP UI ' +
    'if the unfiltered result exceeded the fetch bound.'
  );
}

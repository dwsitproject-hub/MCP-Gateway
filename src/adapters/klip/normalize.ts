/**
 * Normalizer (T-7). The only place business normalization happens (T-3).
 *
 * This module is deliberately PURE - no config, no db, no http - so the
 * Incoterm x status x null matrix can be unit-tested in isolation.
 *
 * Correctness rules, several of them from the design review:
 *
 *  1. Unit conversion happens exactly once, at this boundary. KLIP returns
 *     kilograms despite MT labels in the UI.
 *  2. AGGREGATION HAPPENS IN KILOGRAMS. MT is produced only from the final
 *     aggregate. Rounding per line and then summing drifts away from the KLIP UI
 *     by up to 0.0005 MT per row (review H4.2), which is exactly the kind of
 *     disagreement metric M1 fails on.
 *     Useful identity: 3 decimal places of MT == 1 kg, so "MT to 3 dp" is just
 *     "kg rounded to the nearest integer, divided by 1000". No precision is lost.
 *  3. Nulls propagate as null with a data_quality note. They are never coalesced
 *     to zero, and a line with a null input is excluded from totals rather than
 *     contributing a fabricated 0.
 *  4. An unrecognised incoterm or status is a data-quality exclusion, never a
 *     silent default to the shipped basis (review H4.3).
 *  5. Negative outstanding (over-shipment / over-receipt) is reported as-is and
 *     flagged. Clamping it to zero would make the total disagree with the UI
 *     (review H4.4).
 */

import { enums } from './routes.js';

// ---------------------------------------------------------------------------
// Units and rounding
// ---------------------------------------------------------------------------

/** Round half away from zero, so over-delivery (negative) rounds symmetrically. */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Kilograms to metric tonnes, 3 decimal places.
 * Returns null for null/undefined/non-finite input - never 0.
 */
export function kgToMt(kg: number | null | undefined): number | null {
  if (kg === null || kg === undefined || !Number.isFinite(kg)) return null;
  return roundHalfAwayFromZero(kg) / 1000;
}

/** Sum kilogram values, ignoring nulls. Returns null when nothing summable was present. */
export function sumKg(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  let seen = false;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    total += v;
    seen = true;
  }
  return seen ? total : null;
}

// ---------------------------------------------------------------------------
// Timestamps (WIB, +07:00)
// ---------------------------------------------------------------------------

const WIB_OFFSET_MINUTES = 7 * 60;

/** ISO-8601 with an explicit +07:00 offset (TSD Section 7.4). */
export function toWibIso(input: Date | string | number | null | undefined): string | null {
  if (input === null || input === undefined || input === '') return null;
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + WIB_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 19)}+07:00`;
}

/** Date-only fields stay date-only: no spurious time component, no timezone shift. */
export function toDateOnly(input: string | Date | null | undefined): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(input);
    if (match?.[1] !== undefined) return match[1];
    const parsed = new Date(input);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  return Number.isNaN(input.getTime()) ? null : input.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Incoterm-driven outstanding quantity
// ---------------------------------------------------------------------------

export type OutstandingBasis = 'shipped' | 'received';

export type DataQualityNote =
  | 'unknown_incoterm'
  | 'unknown_status'
  | 'missing_qty_po'
  | 'missing_basis_quantity'
  | 'negative_outstanding'
  | 'completed_status_treatment_unconfirmed';

/**
 * Whether a COMPLETED contract's outstanding is forced to zero.
 *
 * PRD 8.1 zeroes only Closed/Batal, but the TSD test matrix also lists COMPLETED,
 * and the two readings give different totals. Kept as one named constant so the
 * answer from Appendix A is a one-line change rather than a hunt.
 * TODO(P1): confirm against the KLIP UI and set enums.verified = true.
 */
export const COMPLETED_ZEROES_OUTSTANDING = false;

export interface ContractLineInput {
  contract_id: string;
  po_number?: string | null;
  supplier?: string | null;
  product?: string | null;
  plant?: string | null;
  incoterm?: string | null;
  status?: string | null;
  /** Quantities in KILOGRAMS as returned by KLIP. */
  qty_po_kg?: number | null;
  shipped_kg?: number | null;
  received_kg?: number | null;
}

export interface OutstandingLine {
  contract_id: string;
  po_number: string | null;
  supplier: string | null;
  product: string | null;
  plant: string | null;
  incoterm: string | null;
  status: string | null;
  basis: OutstandingBasis | null;
  qty_po_kg: number | null;
  basis_qty_kg: number | null;
  outstanding_kg: number | null;
  /** True when this line's outstanding_kg may be added to a total. */
  countable: boolean;
  data_quality: DataQualityNote[];
}

function canon(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

export function basisFor(incoterm: string | null | undefined): OutstandingBasis | null {
  const key = canon(incoterm);
  if (key === null) return null;
  if ((enums.shippedBasisIncoterms as readonly string[]).includes(key)) return 'shipped';
  if ((enums.receivedBasisIncoterms as readonly string[]).includes(key)) return 'received';
  return null;
}

export type StatusClass = 'open' | 'completed' | 'zeroed' | 'unknown';

export function classifyStatus(status: string | null | undefined): StatusClass {
  const key = canon(status);
  if (key === null) return 'unknown';
  if ((enums.zeroOutstandingStatuses as readonly string[]).includes(key)) return 'zeroed';
  if ((enums.openStatuses as readonly string[]).includes(key)) return 'open';
  if ((enums.completedStatuses as readonly string[]).includes(key)) return 'completed';
  return 'unknown';
}

/**
 * Outstanding quantity for one contract line, in kilograms.
 *
 *   FOB / Loco  -> qty_po - shipped
 *   Franco / CIF -> qty_po - received
 *   Closed / Batal -> 0
 */
export function outstanding(line: ContractLineInput): OutstandingLine {
  const notes: DataQualityNote[] = [];
  const basis = basisFor(line.incoterm);
  const statusClass = classifyStatus(line.status);

  const qtyPo = line.qty_po_kg ?? null;
  const shipped = line.shipped_kg ?? null;
  const received = line.received_kg ?? null;

  const base: Omit<OutstandingLine, 'basis_qty_kg' | 'outstanding_kg' | 'countable' | 'data_quality'> = {
    contract_id: line.contract_id,
    po_number: line.po_number ?? null,
    supplier: line.supplier ?? null,
    product: line.product ?? null,
    plant: line.plant ?? null,
    incoterm: line.incoterm ?? null,
    status: line.status ?? null,
    basis,
    qty_po_kg: qtyPo,
  };

  // Cancelled / closed contracts count as zero regardless of quantities.
  if (statusClass === 'zeroed') {
    return { ...base, basis_qty_kg: null, outstanding_kg: 0, countable: true, data_quality: notes };
  }

  if (statusClass === 'completed') {
    if (COMPLETED_ZEROES_OUTSTANDING) {
      return { ...base, basis_qty_kg: null, outstanding_kg: 0, countable: true, data_quality: notes };
    }
    notes.push('completed_status_treatment_unconfirmed');
  }

  if (statusClass === 'unknown') notes.push('unknown_status');

  if (basis === null) {
    // No defensible basis: exclude rather than assume "shipped".
    notes.push('unknown_incoterm');
    return { ...base, basis_qty_kg: null, outstanding_kg: null, countable: false, data_quality: notes };
  }

  const basisQty = basis === 'shipped' ? shipped : received;

  if (qtyPo === null) notes.push('missing_qty_po');
  if (basisQty === null) notes.push('missing_basis_quantity');

  if (qtyPo === null || basisQty === null) {
    return { ...base, basis_qty_kg: basisQty, outstanding_kg: null, countable: false, data_quality: notes };
  }

  const value = qtyPo - basisQty;
  if (value < 0) notes.push('negative_outstanding');

  return { ...base, basis_qty_kg: basisQty, outstanding_kg: value, countable: true, data_quality: notes };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface OutstandingTotals {
  qty_po_mt: number | null;
  shipped_mt: number | null;
  received_mt: number | null;
  outstanding_mt: number | null;
  contracts: number;
  /** Lines excluded from outstanding_mt because an input was null or unmapped. */
  excluded_lines: number;
  data_quality_counts: Partial<Record<DataQualityNote, number>>;
}

export interface IncotermBreakdown {
  incoterm: string;
  basis: OutstandingBasis | null;
  contracts: number;
  outstanding_mt: number | null;
  excluded_lines: number;
}

/**
 * Aggregate outstanding lines. All arithmetic is in kilograms; the single
 * kg -> MT conversion is applied to the finished totals (review H4.2).
 */
export function aggregateOutstanding(lines: readonly OutstandingLine[]): OutstandingTotals {
  const counts: Partial<Record<DataQualityNote, number>> = {};
  let outstandingKg: number | null = null;
  let excluded = 0;

  for (const line of lines) {
    for (const note of line.data_quality) counts[note] = (counts[note] ?? 0) + 1;
    if (!line.countable || line.outstanding_kg === null) {
      excluded += 1;
      continue;
    }
    outstandingKg = (outstandingKg ?? 0) + line.outstanding_kg;
  }

  return {
    qty_po_mt: kgToMt(sumKg(lines.map((l) => l.qty_po_kg))),
    shipped_mt: kgToMt(sumKg(lines.map((l) => (l.basis === 'shipped' ? l.basis_qty_kg : null)))),
    received_mt: kgToMt(sumKg(lines.map((l) => (l.basis === 'received' ? l.basis_qty_kg : null)))),
    outstanding_mt: kgToMt(outstandingKg),
    contracts: lines.length,
    excluded_lines: excluded,
    data_quality_counts: counts,
  };
}

export function groupByIncoterm(lines: readonly OutstandingLine[]): IncotermBreakdown[] {
  const groups = new Map<string, { basis: OutstandingBasis | null; kg: number | null; contracts: number; excluded: number }>();

  for (const line of lines) {
    const key = line.incoterm ?? '(none)';
    const existing = groups.get(key) ?? { basis: line.basis, kg: null, contracts: 0, excluded: 0 };
    existing.contracts += 1;
    if (line.countable && line.outstanding_kg !== null) existing.kg = (existing.kg ?? 0) + line.outstanding_kg;
    else existing.excluded += 1;
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([incoterm, g]) => ({
      incoterm,
      basis: g.basis,
      contracts: g.contracts,
      outstanding_mt: kgToMt(g.kg),
      excluded_lines: g.excluded,
    }))
    .sort((a, b) => (b.outstanding_mt ?? -Infinity) - (a.outstanding_mt ?? -Infinity));
}

/** Top-N slice, taken AFTER aggregation so totals cover the full fetch (TSD 7.3). */
export function topByOutstanding(lines: readonly OutstandingLine[], limit: number): OutstandingLine[] {
  return [...lines]
    .filter((l) => l.outstanding_kg !== null)
    .sort((a, b) => (b.outstanding_kg ?? 0) - (a.outstanding_kg ?? 0))
    .slice(0, limit);
}

/** Trucking gain/loss, in kilograms. Nulls propagate. */
export function gainLossKg(sentKg: number | null | undefined, deliveredKg: number | null | undefined): number | null {
  if (sentKg === null || sentKg === undefined || deliveredKg === null || deliveredKg === undefined) return null;
  if (!Number.isFinite(sentKg) || !Number.isFinite(deliveredKg)) return null;
  return deliveredKg - sentKg;
}

/** Whole days between two dates; positive means later than reference. Nulls propagate. */
export function deviationDays(reference: string | Date | null | undefined, actual: string | Date | null | undefined): number | null {
  const a = toDateOnly(reference);
  const b = toDateOnly(actual);
  if (a === null || b === null) return null;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86_400_000);
}

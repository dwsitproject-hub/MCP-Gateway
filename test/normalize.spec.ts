/**
 * The Incoterm x status x null matrix. Written BEFORE the tools, per the
 * implementation guide, because every M1 accuracy failure passes through here.
 */
import { describe, expect, it } from 'vitest';
import { aggregateOutstanding, basisFor, classifyStatus, COMPLETED_ZEROES_OUTSTANDING, deviationDays, gainLossKg, groupByIncoterm, kgToMt, outstanding, roundHalfAwayFromZero, sumKg, toDateOnly, topByOutstanding, toWibIso, type ContractLineInput, isImplausiblyFuture } from '../src/adapters/klip/normalize.js';

const line = (over: Partial<ContractLineInput> = {}): ContractLineInput => ({
  contract_id: 'C-1',
  incoterm: 'FOB',
  status: 'ACTIVE',
  qty_po_kg: 1_000_000,
  shipped_kg: 400_000,
  received_kg: 300_000,
  ...over,
});

// ---------------------------------------------------------------------------
describe('kgToMt - the kg-labelled-as-MT trap', () => {
  it('divides by 1000 exactly once', () => {
    expect(kgToMt(1_000_000)).toBe(1000);
    expect(kgToMt(1_234_567)).toBe(1234.567);
  });

  it('expresses 3 dp of MT as whole kilograms', () => {
    // 0.001 MT == 1 kg, so fractional kg rounds to the nearest kg.
    expect(kgToMt(1_234_567.4)).toBe(1234.567);
    expect(kgToMt(1_234_567.6)).toBe(1234.568);
  });

  it('rounds half away from zero, symmetrically for over-delivery', () => {
    expect(kgToMt(500)).toBe(0.5);
    expect(kgToMt(0.5)).toBe(0.001);
    expect(kgToMt(-0.5)).toBe(-0.001);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
  });

  it('returns null - never zero - for absent or non-finite input', () => {
    expect(kgToMt(null)).toBeNull();
    expect(kgToMt(undefined)).toBeNull();
    expect(kgToMt(Number.NaN)).toBeNull();
    expect(kgToMt(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps a genuine zero distinguishable from a missing value', () => {
    expect(kgToMt(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('sumKg', () => {
  it('ignores nulls but returns null when nothing was summable', () => {
    expect(sumKg([1, null, 2, undefined])).toBe(3);
    expect(sumKg([null, undefined])).toBeNull();
    expect(sumKg([])).toBeNull();
    expect(sumKg([0])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('basis selection', () => {
  it('maps FOB and Loco to the shipped basis, case-insensitively', () => {
    expect(basisFor('FOB')).toBe('shipped');
    expect(basisFor('fob')).toBe('shipped');
    expect(basisFor('  Loco ')).toBe('shipped');
  });

  it('maps Franco and CIF to the received basis', () => {
    expect(basisFor('Franco')).toBe('received');
    expect(basisFor('CIF')).toBe('received');
  });

  it('refuses to guess a basis for an unmapped incoterm', () => {
    for (const value of ['CFR', 'DAP', 'Ex-Works', '', '   ', null, undefined]) {
      expect(basisFor(value)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
describe('status classification', () => {
  it('recognises the mixed-language, mixed-case values the documents use', () => {
    expect(classifyStatus('ACTIVE')).toBe('open');
    expect(classifyStatus('Aktif')).toBe('open');
    expect(classifyStatus('COMPLETED')).toBe('completed');
    expect(classifyStatus('Closed')).toBe('zeroed');
    expect(classifyStatus('Batal')).toBe('zeroed');
    expect(classifyStatus('batal')).toBe('zeroed');
  });

  it('classifies anything else as unknown rather than assuming open', () => {
    expect(classifyStatus('PENDING_APPROVAL')).toBe('unknown');
    expect(classifyStatus(null)).toBe('unknown');
    expect(classifyStatus('')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
describe('outstanding() - Incoterm x status matrix', () => {
  it('FOB and Loco subtract shipped', () => {
    for (const incoterm of ['FOB', 'Loco']) {
      const r = outstanding(line({ incoterm }));
      expect(r.basis).toBe('shipped');
      expect(r.outstanding_kg).toBe(600_000);
      expect(r.countable).toBe(true);
      expect(r.data_quality).toEqual([]);
    }
  });

  it('Franco and CIF subtract received', () => {
    for (const incoterm of ['Franco', 'CIF']) {
      const r = outstanding(line({ incoterm }));
      expect(r.basis).toBe('received');
      expect(r.outstanding_kg).toBe(700_000);
      expect(r.countable).toBe(true);
    }
  });

  it('zeroes Closed and Batal regardless of quantities', () => {
    for (const status of ['Closed', 'Batal', 'CANCELLED']) {
      const r = outstanding(line({ status, qty_po_kg: 9_000_000, shipped_kg: 0 }));
      expect(r.outstanding_kg).toBe(0);
      expect(r.countable).toBe(true);
    }
  });

  it('zeroes a cancelled contract even when the incoterm is unmapped', () => {
    const r = outstanding(line({ status: 'Batal', incoterm: 'DAP' }));
    expect(r.outstanding_kg).toBe(0);
    expect(r.countable).toBe(true);
  });

  it('flags COMPLETED as an unconfirmed treatment instead of silently choosing', () => {
    const r = outstanding(line({ status: 'COMPLETED' }));
    if (COMPLETED_ZEROES_OUTSTANDING) {
      expect(r.outstanding_kg).toBe(0);
    } else {
      expect(r.outstanding_kg).toBe(600_000);
      expect(r.data_quality).toContain('completed_status_treatment_unconfirmed');
    }
  });

  it('excludes a line with an unmapped incoterm rather than defaulting to shipped', () => {
    const r = outstanding(line({ incoterm: 'CFR' }));
    expect(r.basis).toBeNull();
    expect(r.outstanding_kg).toBeNull();
    expect(r.countable).toBe(false);
    expect(r.data_quality).toContain('unknown_incoterm');
  });

  it('propagates a null Qty PO as null, never as zero', () => {
    const r = outstanding(line({ qty_po_kg: null }));
    expect(r.outstanding_kg).toBeNull();
    expect(r.countable).toBe(false);
    expect(r.data_quality).toContain('missing_qty_po');
  });

  it('propagates a null basis quantity as null', () => {
    const fob = outstanding(line({ incoterm: 'FOB', shipped_kg: null }));
    expect(fob.outstanding_kg).toBeNull();
    expect(fob.data_quality).toContain('missing_basis_quantity');

    // A null on the OTHER basis must not matter.
    const cif = outstanding(line({ incoterm: 'CIF', shipped_kg: null, received_kg: 250_000 }));
    expect(cif.outstanding_kg).toBe(750_000);
    expect(cif.data_quality).toEqual([]);
  });

  it('reports over-delivery as a negative figure and flags it, without clamping', () => {
    const r = outstanding(line({ qty_po_kg: 1_000_000, shipped_kg: 1_050_000 }));
    expect(r.outstanding_kg).toBe(-50_000);
    expect(r.countable).toBe(true);
    expect(r.data_quality).toContain('negative_outstanding');
  });

  it('flags an unknown status but still computes when the basis is known', () => {
    const r = outstanding(line({ status: 'PENDING' }));
    expect(r.outstanding_kg).toBe(600_000);
    expect(r.data_quality).toContain('unknown_status');
  });

  it('treats a fully shipped open contract as zero outstanding, not as missing', () => {
    const r = outstanding(line({ qty_po_kg: 500_000, shipped_kg: 500_000 }));
    expect(r.outstanding_kg).toBe(0);
    expect(r.countable).toBe(true);
    expect(r.data_quality).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('aggregation', () => {
  it('sums in kilograms and converts once, so totals do not drift', () => {
    // Each line is 0.4 kg of outstanding: rounding per line then summing would
    // give 3 x 0.000 = 0 MT. Summing kg first gives 1.2 kg -> 0.001 MT.
    const lines = [1, 2, 3].map((n) =>
      outstanding(line({ contract_id: `C-${n}`, qty_po_kg: 100.4, shipped_kg: 100 })),
    );
    const totals = aggregateOutstanding(lines);
    expect(totals.outstanding_mt).toBe(0.001);
  });

  it('excludes null lines from the total and counts them', () => {
    const lines = [
      outstanding(line({ contract_id: 'A' })),
      outstanding(line({ contract_id: 'B', qty_po_kg: null })),
      outstanding(line({ contract_id: 'C', incoterm: 'DAP' })),
    ];
    const totals = aggregateOutstanding(lines);
    expect(totals.outstanding_mt).toBe(600);
    expect(totals.contracts).toBe(3);
    expect(totals.excluded_lines).toBe(2);
    expect(totals.data_quality_counts.missing_qty_po).toBe(1);
    expect(totals.data_quality_counts.unknown_incoterm).toBe(1);
  });

  it('returns null totals rather than zero when nothing was countable', () => {
    const totals = aggregateOutstanding([outstanding(line({ qty_po_kg: null, shipped_kg: null, received_kg: null }))]);
    expect(totals.outstanding_mt).toBeNull();
    expect(totals.qty_po_mt).toBeNull();
  });

  it('attributes basis quantities to the right column', () => {
    const totals = aggregateOutstanding([
      outstanding(line({ contract_id: 'A', incoterm: 'FOB', shipped_kg: 100_000, received_kg: 90_000 })),
      outstanding(line({ contract_id: 'B', incoterm: 'CIF', shipped_kg: 100_000, received_kg: 80_000 })),
    ]);
    expect(totals.shipped_mt).toBe(100);
    expect(totals.received_mt).toBe(80);
  });

  it('groups by incoterm with per-group exclusions', () => {
    const groups = groupByIncoterm([
      outstanding(line({ contract_id: 'A', incoterm: 'FOB' })),
      outstanding(line({ contract_id: 'B', incoterm: 'FOB', qty_po_kg: null })),
      outstanding(line({ contract_id: 'C', incoterm: 'CIF' })),
    ]);
    const fob = groups.find((g) => g.incoterm === 'FOB');
    expect(fob?.contracts).toBe(2);
    expect(fob?.excluded_lines).toBe(1);
    expect(fob?.outstanding_mt).toBe(600);
  });

  it('slices top-N after aggregating, and drops null lines from the slice', () => {
    const lines = [
      outstanding(line({ contract_id: 'small', qty_po_kg: 10_000, shipped_kg: 0 })),
      outstanding(line({ contract_id: 'big', qty_po_kg: 900_000, shipped_kg: 0 })),
      outstanding(line({ contract_id: 'null', qty_po_kg: null })),
    ];
    const top = topByOutstanding(lines, 2);
    expect(top.map((l) => l.contract_id)).toEqual(['big', 'small']);
  });
});

// ---------------------------------------------------------------------------
describe('trucking gain/loss and payment deviation', () => {
  it('computes gain/loss with nulls propagating', () => {
    expect(gainLossKg(100_000, 99_500)).toBe(-500);
    expect(gainLossKg(100_000, 100_500)).toBe(500);
    expect(gainLossKg(null, 100)).toBeNull();
    expect(gainLossKg(100, null)).toBeNull();
  });

  it('computes deviation days from due date to paid date', () => {
    expect(deviationDays('2026-08-01', '2026-08-06')).toBe(5);
    expect(deviationDays('2026-08-10', '2026-08-05')).toBe(-5);
    expect(deviationDays('2026-08-01', null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('timestamps', () => {
  it('renders WIB with an explicit +07:00 offset', () => {
    expect(toWibIso('2026-08-19T07:32:05.000Z')).toBe('2026-08-19T14:32:05+07:00');
  });

  it('returns null for absent or unparseable input', () => {
    expect(toWibIso(null)).toBeNull();
    expect(toWibIso('')).toBeNull();
    expect(toWibIso('not a date')).toBeNull();
  });

  it('keeps date-only fields date-only, with no timezone shift', () => {
    expect(toDateOnly('2026-08-19')).toBe('2026-08-19');
    expect(toDateOnly('2026-08-19T23:30:00+07:00')).toBe('2026-08-19');
    expect(toDateOnly(null)).toBeNull();
  });
});

describe('implausible future timestamps', () => {
  // KLIP stamped a COMPLETED SAP import at 11:35:50Z while the real time was 08:05:19Z
  // (observed 2026-08-24). The value carries an explicit Z so the WIB conversion is
  // arithmetically right - the input is wrong. Reporting it as plain fact would let a
  // tool answer "did today's import work?" with a time that has not happened.
  const NOW = Date.parse('2026-08-24T08:05:19Z');

  it('flags a completed-in-the-future timestamp', () => {
    expect(isImplausiblyFuture('2026-08-24T18:35:50+07:00', NOW)).toBe(true);
  });

  it('accepts a normal past timestamp', () => {
    expect(isImplausiblyFuture('2026-08-24T14:00:00+07:00', NOW)).toBe(false);
  });

  it('tolerates small clock skew rather than crying wolf', () => {
    // Two minutes ahead is ordinary drift between hosts, not a data defect.
    expect(isImplausiblyFuture(new Date(NOW + 2 * 60_000).toISOString(), NOW)).toBe(false);
  });

  it('flags anything beyond the tolerance', () => {
    expect(isImplausiblyFuture(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe(true);
  });

  it('treats a null timestamp as unremarkable, not as suspicious', () => {
    // sapImport has no finished_at at all; absent must not read as a defect.
    expect(isImplausiblyFuture(null, NOW)).toBe(false);
  });

  it('does not flag an unparseable value', () => {
    expect(isImplausiblyFuture('not a date', NOW)).toBe(false);
  });
});

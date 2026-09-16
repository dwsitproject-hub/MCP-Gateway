/**
 * Vessel-name matching between JPS and KLIP.
 *
 * The scoring is the easy half and these tests spend little time on it. What they pin
 * is the thing the measurements forced: a vessel name is a LABEL, not a key, so the
 * tool must never collapse several KLIP rows into one answer however well they score.
 *
 * Measured 11 Sep 2026 and worth keeping in view while reading these:
 *   - 85 JPS shipment plans, 0 with an externalReference
 *   - 87 shipping instructions, 0 with a KLIP-shaped STO number
 *   - KLIP holds VICTORIA 11 as planned, at-discharge-port AND cancelled at once
 *   - JPS showed 4 vessels alongside while KLIP showed 12 berthed or unloading
 */
import { describe, expect, it } from 'vitest';
import { normaliseVesselName, similarity, vesselSimilarity } from '../src/tools/jetty/vesselCrosscheck.js';

describe('normalising a vessel name', () => {
  it.each([
    ['BG KIRANA LIBRA II', 'KIRANA LIBRA II'],
    ['KIRANA LIBRA II', 'KIRANA LIBRA II'],
    ['MT. VICTORIA 11', 'VICTORIA 11'],
    ['VICTORIA 11', 'VICTORIA 11'],
    ['BG. MEL 01', 'MEL 01'],
    ['KLM.MORUT', 'MORUT'],
    ['MT MULIA KARSA 5', 'MULIA KARSA 5'],
  ])('%s -> %s', (raw, expected) => {
    // The prefixes describe the HULL, not the identity, and the two systems disagree
    // about whether to include them. This is the part that genuinely is a spelling
    // difference, and it is handled before any scoring happens.
    expect(normaliseVesselName(raw)).toBe(expected);
  });

  it('strips a repeated prefix rather than only the first', () => {
    expect(normaliseVesselName('MT. BG SAMUDRA 8')).toBe('SAMUDRA 8');
  });
});

describe('similarity', () => {
  it('scores an exact normalised match at 1', () => {
    expect(similarity(normaliseVesselName('BG KIRANA LIBRA II'), normaliseVesselName('KIRANA LIBRA II'))).toBe(1);
  });

  it('scores a near-miss high enough to surface at the default threshold', () => {
    const s = similarity(normaliseVesselName('MT. GIAT ARMADA 02'), normaliseVesselName('GIAT ARMADA 2'));
    expect(s).toBeGreaterThan(0.8);
  });

  it('scores a different hull in the same fleet ABOVE 0.8 on text alone', () => {
    /**
     * Why a plain similarity threshold cannot work here, stated as a measurement.
     * LUMINOR 2 and LUMINOR 10 are different barges and differ by one character in
     * eighteen, so they score 0.82 - over any threshold anyone would choose. Fleets
     * number their hulls, so the digits carry nearly all the identity while
     * contributing nearly none of the string.
     */
    const a = normaliseVesselName('BG. LUMINOR 2');
    const b = normaliseVesselName('BG. LUMINOR 10');
    expect(similarity(a, b)).toBeGreaterThan(0.8);
  });

  it('and vesselSimilarity refuses it anyway, because the hull numbers differ', () => {
    // The domain rule that makes an 80% threshold safe to use at all.
    expect(vesselSimilarity(normaliseVesselName('BG. LUMINOR 2'), normaliseVesselName('BG. LUMINOR 10'))).toBe(0);
    expect(vesselSimilarity(normaliseVesselName('SAHABAT SETIA 2689'), normaliseVesselName('SAHABAT SETIA 1689'))).toBe(0);
  });

  it('treats 02 and 2 as the SAME hull, comparing numerically', () => {
    // "MT. GIAT ARMADA 02" in one system and "GIAT ARMADA 2" in the other is a
    // formatting difference, not a different barge.
    expect(
      vesselSimilarity(normaliseVesselName('MT. GIAT ARMADA 02'), normaliseVesselName('GIAT ARMADA 2')),
    ).toBeGreaterThan(0.8);
  });

  it('leaves a missing number to the text score rather than refusing outright', () => {
    // One name carrying no number is a plausible omission, not evidence of a different
    // hull - so it is not hard-zeroed.
    expect(vesselSimilarity(normaliseVesselName('LUMINOR'), normaliseVesselName('LUMINOR 6'))).toBeGreaterThan(0);
  });

  it('does not match two unrelated vessels', () => {
    expect(similarity(normaliseVesselName('EIHO'), normaliseVesselName('MT. VICTORIA 11'))).toBeLessThan(0.5);
  });

  it('is symmetric', () => {
    const a = normaliseVesselName('BG. SAHABAT SETIA 2689');
    const b = normaliseVesselName('SAHABAT SETIA 1689');
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });

  it('refuses to score a one-character name rather than returning a flattering number', () => {
    expect(similarity('A', 'A B')).toBe(0);
  });
});

describe('what the scoring cannot fix', () => {
  it('scores one JPS name identically against SEVERAL KLIP rows', () => {
    /**
     * The heart of it. KLIP carries the same vessel on many shipments, and every one of
     * them scores the same against the JPS name - so similarity cannot choose between
     * them, at any threshold. That is why the tool returns candidates with their scores
     * instead of a match, and why "several candidates" is documented as the normal case
     * rather than an error.
     */
    const jps = normaliseVesselName('MT VICTORIA 11');
    const klipRows = ['MT. VICTORIA 11', 'VICTORIA 11', 'VICTORIA 11'];
    const scores = klipRows.map((k) => similarity(jps, normaliseVesselName(k)));
    expect(scores.every((s) => s === 1)).toBe(true);
    // Three rows, one score, no way to pick. Raising the threshold does not help:
    // they are all perfect matches of the same label on different voyages.
    expect(new Set(scores).size).toBe(1);
  });
});

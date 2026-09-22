/**
 * Every field the map READS must be used by some tool.
 *
 * Three times in three days the connector reported its own omission as the upstream's:
 * unit_price, the tank farm, and the eight berthing and start milestones. The last one
 * is the shape this file catches - fields.shipment mapped all eighteen rungs, the tool
 * emitted ten, and nothing anywhere recorded that the other eight were a choice. Asked
 * about ATA berthing detail, the connector said it did not have data it had been
 * reading on every row.
 *
 * A mapped field that no tool touches is one of two things, and they need different
 * answers:
 *
 *   an oversight   - wire it up
 *   a decision     - write it in DELIBERATELY_UNSURFACED below, with the reason
 *
 * The allowlist is the point of the test, not a way around it. It turns "we don't
 * surface that" from something nobody wrote down into something with a name attached.
 *
 * What this does NOT catch is the other shape: a field KLIP returns that the map never
 * claims, which is how unit_price hid for a month. That one needs live data and belongs
 * in `routes:verify-fields`, which now reports unmapped upstream keys per route.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIELDS_FILE = join(process.cwd(), 'src/adapters/klip/fields.ts');
const TOOL_DIRS = [join(process.cwd(), 'src/tools/klip'), join(process.cwd(), 'src/tools/jetty')];

/**
 * Mapped on purpose and not surfaced. Each entry is a decision with a reason; an entry
 * with no reason is just the bug wearing a disguise.
 */
const DELIBERATELY_UNSURFACED: Record<string, string> = {
  'oilLoss.sent':
    'quantity_sent is present here but contradicts KLIP-004, which found it empty on all 6,766 ' +
    'trucking rows. Provenance and coverage are open with the KLIP team, so it is read but not ' +
    'reported until they answer.',

  'contract.unit':
    'The per-row unit field reads "MT" while the values are KILOGRAMS - the trap the whole connector ' +
    'converts around. Surfacing it would put a label next to a figure that contradicts it, and the ' +
    'reader would believe the label. Quantities are converted in code and the envelope declares MT.',

  // Internal row identifiers. They address a record inside KLIP and mean nothing to a
  // reader; the identifiers people actually use are the STO, PO and contract numbers.
  'shipment.id': 'KLIP internal row id, not a business identifier. STO, PO and contract numbers are reported instead.',
  'trucking.id': 'KLIP internal row id, not a business identifier. The contract and STO are reported instead.',
  'quality.id': 'KLIP internal row id, not a business identifier. The COA and shipment numbers are reported instead.',
  'payment.id': 'KLIP internal row id, not a business identifier. The invoice number is reported instead.',

  'shipment.isDelayed':
    'MEASURED FALSE ON EVERY ROW, including shipments the KLIP page itself marks Late. It is therefore ' +
    'not the page indicator it appears to be, and reporting it would contradict the screen. Named in ' +
    'the not_available note so the absence is visible rather than silent.',
  'shipment.slaDays':
    'Empty on every row in KLIP. Reported as not_available rather than as a null field, so nobody reads ' +
    'the null as an SLA of zero days.',
  'shipment.sfalQty':
    'Empty on every row in KLIP. Reported as not_available rather than as a null quantity, because a ' +
    'null loss figure reads as no loss.',
  'shipment.sfbdQty':
    'Empty on every row in KLIP. Reported as not_available rather than as a null quantity, because a ' +
    'null loss figure reads as no loss.',

  'shipment.outstandingQtyPlanning':
    'A SECOND outstanding column whose relationship to outstanding_quantity is unconfirmed. Publishing ' +
    'two outstanding figures without knowing which is authoritative invites the reader to pick the one ' +
    'that suits, which is exactly the failure this connector removes elsewhere. Open with KLIP.',

  'oilLoss.id': 'KLIP internal row id. operation_id and the contract/STO numbers are reported instead.',
  'oilLoss.sfal':
    'Empty on every row in KLIP, like its shipment counterpart. Reported as absent rather than as a null ' +
    'loss quantity, because a null loss reads as no loss - the one misreading this tool must not invite.',
  'oilLoss.sfbd':
    'Empty on every row in KLIP, like its shipment counterpart. Reported as absent rather than as a null ' +
    'loss quantity, because a null loss reads as no loss.',

  'shippingPerformance.id': 'KLIP internal row id. The STO and contract numbers are reported instead.',
  'shippingPerformance.shipmentId': 'KLIP internal join id, meaningless outside KLIP. The STO number identifies the row.',
  'shippingPerformance.operationId': 'KLIP internal join id, meaningless outside KLIP. The STO number identifies the row.',

  // The eighteen raw milestone timestamps on THIS endpoint. Deliberate, and the reason
  // is the one stated in the file header: these two tools cover different row sets.
  ...Object.fromEntries(
    [
      'loadEtaArrival', 'loadEtaBerthed', 'loadEtaStart', 'loadEtaCompleted', 'loadEtaSailed',
      'loadAtaArrival', 'loadAtaBerthed', 'loadAtaStart', 'loadAtaCompleted', 'loadAtaSailed',
      'dischEtaArrival', 'dischEtaBerthed', 'dischEtaStart', 'dischEtaCompleted',
      'dischAtaArrival', 'dischAtaBerthed', 'dischAtaStart', 'dischAtaCompleted',
    ].map((k) => [
      `shippingPerformance.${k}`,
      'This tool answers DELAY and reports the delta columns KLIP computes, from exactly ' +
        'these timestamps - emitting both would invite a reader to recompute a delta and get a second ' +
        'answer. The ladder itself belongs to klip_shipment_status, and the two tools cover DIFFERENT ' +
        'row sets by design, so carrying the same field names in both is how they would get mixed.',
    ]),
  ),

  'quality.surveyorCharges':
    'A cost in currency on a tool that answers quality RESULTS - FFA, moisture, dirt. Putting a charge ' +
    'beside a set of quality metrics invites it being totalled as though it were one. It belongs with ' +
    'the finance tools if it is wanted, not here.',
};

function mapsFromFieldsFile(): Map<string, Set<string>> {
  const src = readFileSync(FIELDS_FILE, 'utf8');
  const start = src.indexOf('export const fields');
  const body = src.slice(start);
  const maps = new Map<string, Set<string>>();

  // Top-level map names sit at two-space indent; their entries at four.
  const mapRe = /^ {2}(\w+): \{$/gm;
  let m: RegExpExecArray | null;
  const starts: Array<{ name: string; at: number }> = [];
  while ((m = mapRe.exec(body)) !== null) starts.push({ name: m[1] ?? '', at: m.index });

  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]?.at ?? 0;
    const to = starts[i + 1]?.at ?? body.length;
    const section = body.slice(from, to);
    const keys = new Set<string>();
    for (const km of section.matchAll(/^ {4}(\w+): \[/gm)) keys.add(km[1] ?? '');
    maps.set(starts[i]?.name ?? '', keys);
  }
  return maps;
}

function referencedFields(): Set<string> {
  const used = new Set<string>();
  for (const dir of TOOL_DIRS) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');

      // Direct: fields.shipment.etaLoadBerthed
      for (const m of src.matchAll(/\bfields\.(\w+)\.(\w+)/g)) used.add(`${m[1] ?? ''}.${m[2] ?? ''}`);

      // Bound: const f = fields.shipment;  then  f.etaLoadBerthed
      const bindings = [...src.matchAll(/const \w+ = fields\.(\w+);/g)].map((b) => b[1] ?? '');
      if (bindings.length > 0) {
        for (const m of src.matchAll(/\bf\.(\w+)\b/g)) {
          // A file can bind more than one map; credit the field to each, which is
          // conservative - it can hide a gap but never invent one.
          for (const map of bindings) used.add(`${map}.${m[1] ?? ''}`);
        }
      }
    }
  }
  return used;
}

describe('field maps and the tools that read them', () => {
  const maps = mapsFromFieldsFile();
  const used = referencedFields();

  it('parsed the field maps at all', () => {
    // A regex that silently matches nothing would make every assertion below pass.
    expect(maps.size).toBeGreaterThan(5);
    expect(maps.get('shipment')?.size ?? 0).toBeGreaterThan(30);
    expect(used.size).toBeGreaterThan(50);
  });

  it('has every mapped field read by a tool, or written down as deliberate', () => {
    const orphans: string[] = [];
    for (const [mapName, keys] of maps) {
      for (const key of keys) {
        const id = `${mapName}.${key}`;
        if (used.has(id)) continue;
        if (DELIBERATELY_UNSURFACED[id] !== undefined) continue;
        orphans.push(id);
      }
    }
    expect(
      orphans,
      `These fields are mapped from KLIP and read by no tool. Either wire them into the tool that ` +
        `should report them, or add them to DELIBERATELY_UNSURFACED with a reason. This is the check ` +
        `that would have caught the eight missing berthing and start milestones.\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the allowlist honest: no entry for a field that is used or does not exist', () => {
    // An allowlist that outlives its reason quietly stops being a decision and starts
    // being noise, and the next person reads it as precedent.
    for (const id of Object.keys(DELIBERATELY_UNSURFACED)) {
      const [mapName = '', key = ''] = id.split('.');
      expect(maps.get(mapName)?.has(key), `${id} is allowlisted but not in the field map`).toBe(true);
      expect(used.has(id), `${id} is allowlisted as unsurfaced but a tool now reads it`).toBe(false);
    }
  });

  it('every entry in the allowlist gives a reason worth reading', () => {
    for (const [id, reason] of Object.entries(DELIBERATELY_UNSURFACED)) {
      expect(reason.length, `${id} needs a real reason, not a placeholder`).toBeGreaterThan(60);
    }
  });
});

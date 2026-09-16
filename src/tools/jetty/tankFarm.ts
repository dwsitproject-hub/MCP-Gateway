/**
 * jetty_tank_farm - "how much CPO is in the Bontang tank farm?"
 *
 * Reads /tank-gauging/latest, the same source behind the JPS Tank Farm page: 60 tanks
 * on production, one row each, gauged.
 *
 * THE UNITS ARE NOT STATED BY JPS, and getting them wrong is a 1000x error. Only
 * `observedDensityKgM3` names its unit; `totalObservedVolume` and `totalMass` do not.
 * Rather than assume, this tool MEASURES the relationship on the rows it just fetched:
 * mass = volume x density holds only if volume is cubic metres and mass is kilograms,
 * so the arithmetic itself identifies the units, and the payload says which reading the
 * data supports. If the rows disagree, it says THAT instead of picking one.
 *
 * The same discipline as everywhere else in this connector: report the source's own
 * fields, and where something must be derived, derive it in the open and label it.
 * Totals are the one derivation here - a sum across the tanks actually listed, with the
 * excluded ones counted, because "how much CPO" is a question about several tanks and
 * JPS returns them one at a time.
 */
import { z } from 'zod';
import { jettyRoutes } from './../../adapters/jetty/routes.js';
import { jettyGet, type JettyCallRecord } from './../../adapters/jetty/session.js';
import { jettyConfigured } from './../../adapters/jetty/client.js';
import { cfg } from './../../core/config.js';
import { capabilityUnavailable } from './../../core/errors.js';
import { describe, type ToolDefinition, type ToolOutcome } from './../klip/types.js';

const CAP = 60;

const inputShape = {
  product: z
    .string()
    .min(1)
    .optional()
    .describe('Narrow to one product, matched loosely, e.g. "CPO", "PKO", "FAME", "RBD".'),
  tank_code: z.string().min(1).optional().describe('Narrow to one tank by its code or name.'),
  limit: z.number().int().min(1).max(CAP).default(CAP).describe(`How many tanks to list (max ${CAP}).`),
};

/** Field names as /tank-gauging/latest spells them. */
interface TankRow {
  tankId?: string | number;
  code?: string;
  name?: string;
  productName?: string;
  levelMm?: number;
  temperatureC?: number;
  observedDensityKgM3?: number;
  totalObservedVolume?: number;
  totalMass?: number;
  flowRateTph?: number;
  statusText?: string;
  levelMovement?: string;
}

const loosely = (value: string | undefined, needle: string | undefined): boolean =>
  needle === undefined || (value ?? '').toLowerCase().includes(needle.toLowerCase());

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * Work out what the volume and mass columns are actually in.
 *
 * mass = volume x density is true by definition; what it pins down is the UNITS. With
 * density in kg/m3, a ratio near 1 means volume is m3 and mass is kg. A ratio near
 * 1000 means mass is in tonnes. Anything else means the assumption is wrong and must
 * not be papered over - so the third case reports disagreement rather than a guess.
 */
function impliedUnits(rows: TankRow[]): { note: string; massUnit: 'kg' | 'tonne' | 'unknown' } {
  const ratios: number[] = [];
  for (const t of rows) {
    const v = t.totalObservedVolume;
    const d = t.observedDensityKgM3;
    const m = t.totalMass;
    if (typeof v !== 'number' || typeof d !== 'number' || typeof m !== 'number') continue;
    if (v <= 0 || d <= 0 || m <= 0) continue;
    ratios.push((v * d) / m);
  }
  if (ratios.length === 0) {
    return {
      massUnit: 'unknown',
      note:
        'No tank carried volume, density and mass together, so the units of totalObservedVolume and ' +
        'totalMass could not be established from the data. Report the raw figures and check the JPS Tank ' +
        'Farm page before converting anything.',
    };
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const agree = ratios.filter((r) => Math.abs(r - median) / median < 0.02).length;
  const basis = `measured on ${String(ratios.length)} tank(s), ${String(agree)} agreeing`;

  if (Math.abs(median - 1) < 0.05) {
    return {
      massUnit: 'kg',
      note: `volume x density divided by mass is ${String(round(median))} (${basis}), so totalObservedVolume is CUBIC METRES and totalMass is KILOGRAMS. Divide mass by 1000 for tonnes.`,
    };
  }
  if (Math.abs(median - 1000) / 1000 < 0.05) {
    return {
      massUnit: 'tonne',
      note: `volume x density divided by mass is ${String(round(median))} (${basis}), so totalObservedVolume is CUBIC METRES and totalMass is already METRIC TONNES. Do not divide again.`,
    };
  }
  return {
    massUnit: 'unknown',
    note:
      `volume x density divided by mass is ${String(round(median))} (${basis}), which matches neither ` +
      'kilograms nor tonnes. The unit of totalMass is therefore UNKNOWN: quote the raw figure, name the ' +
      'field, and do not convert or total it without asking the JPS team.',
  };
}

export const jettyTankFarm: ToolDefinition<typeof inputShape> = {
  name: 'jetty_tank_farm',
  title: 'JPS tank farm stock now',
  cap: CAP,
  description: describe(
    'Current gauged stock in the Jetty Planning System tank farm, tank by tank: tank code and name, ' +
      'product, level, temperature, observed density, volume, mass, flow rate, status and whether the ' +
      'level is rising or falling. This is the source behind the JPS Tank Farm page. ' +
      'Use it for "how much CPO is in the tank farm", "which tanks hold PKO", "is tank T-05 filling". ' +
      'Figures are a LIVE gauge reading, not a period report or a book balance: a tank being pumped is ' +
      'changing as you read it, which is what flow_rate_tph and level_movement are for. ' +
      'UNITS ARE MEASURED, NOT ASSUMED: JPS labels only density, so this tool derives what the volume ' +
      'and mass columns are in from the data itself and states the result in units_note - read it before ' +
      'quoting or converting any figure. ' +
      'Totals across tanks are computed HERE by summing the tanks listed, and the tanks excluded for a ' +
      'missing reading are counted beside them; a total is never reported as if JPS supplied it. ' +
      'NOT KLIP. This is physical stock in a shore tank at one port, not contracted or shipped quantity. ' +
      'klip_outstanding answers what is owed against a contract, and the two must never be added or ' +
      'reconciled - they measure different things about different objects.',
    `Returns at most ${CAP} tanks.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    if (!jettyConfigured()) {
      throw capabilityUnavailable(
        'Jetty Planning System tank farm data',
        'This gateway has no JPS connection configured. That is a deployment gap, NOT a statement that ' +
          'the tank farm is empty - check the JPS Tank Farm page directly.',
      );
    }

    const calls: JettyCallRecord[] = [];
    // The odd one out: this route wants the port as a QUERY parameter and 400s without
    // it, even though every other route reads the x-port-id header.
    const rows = await jettyGet<TankRow[]>(
      jettyRoutes.tankLatest.path,
      { [jettyRoutes.tankLatest.params.portId ?? 'portId']: cfg.JETTY_PORT_ID ?? 1 },
      calls,
    );

    const all = Array.isArray(rows) ? rows : [];
    const units = impliedUnits(all);

    const matched = all.filter(
      (t) =>
        loosely(t.productName, params.product) &&
        (params.tank_code === undefined ||
          loosely(t.code, params.tank_code) ||
          loosely(t.name, params.tank_code)),
    );

    const tanks = matched.slice(0, params.limit).map((t) => ({
      tank_code: t.code ?? null,
      tank_name: t.name ?? null,
      product: t.productName ?? null,
      level_mm: t.levelMm ?? null,
      temperature_c: t.temperatureC ?? null,
      density_kg_m3: t.observedDensityKgM3 ?? null,
      volume: t.totalObservedVolume ?? null,
      mass: t.totalMass ?? null,
      flow_rate_tph: t.flowRateTph ?? null,
      status: t.statusText ?? null,
      level_movement: t.levelMovement ?? null,
    }));

    // Summed here, over the tanks LISTED. Stated as such, with the exclusions counted,
    // because a total that quietly drops a tank with no reading is indistinguishable
    // from a genuinely smaller stock.
    const withMass = matched.filter((t) => typeof t.totalMass === 'number');
    const withVolume = matched.filter((t) => typeof t.totalObservedVolume === 'number');
    const totalMass = withMass.reduce((sum, t) => sum + (t.totalMass ?? 0), 0);
    const totalVolume = withVolume.reduce((sum, t) => sum + (t.totalObservedVolume ?? 0), 0);

    const byProduct = new Map<string, { tanks: number; mass: number; volume: number }>();
    for (const t of matched) {
      const key = t.productName ?? '(unnamed product)';
      const entry = byProduct.get(key) ?? { tanks: 0, mass: 0, volume: 0 };
      entry.tanks += 1;
      entry.mass += typeof t.totalMass === 'number' ? t.totalMass : 0;
      entry.volume += typeof t.totalObservedVolume === 'number' ? t.totalObservedVolume : 0;
      byProduct.set(key, entry);
    }

    const data: Record<string, unknown> = {
      tanks,
      tanks_matching: matched.length,
      tanks_at_this_port: all.length,
      rows_shown: tanks.length,
      totals: {
        mass: round(totalMass),
        volume: round(totalVolume),
        tanks_included_in_mass: withMass.length,
        tanks_excluded_from_mass: matched.length - withMass.length,
        tanks_included_in_volume: withVolume.length,
        tanks_excluded_from_volume: matched.length - withVolume.length,
      },
      by_product: [...byProduct.entries()]
        .map(([product, v]) => ({ product, tanks: v.tanks, mass: round(v.mass), volume: round(v.volume) }))
        .sort((a, b) => b.mass - a.mass),
      units_note: units.note,
      computed_here:
        'The totals and the by_product breakdown are SUMS taken here across the tanks listed above. ' +
        'Every per-tank figure is JPS\'s own. JPS returns tanks one at a time and publishes no total on ' +
        'this endpoint, so a total has to be built - saying where it came from is the price of that.',
      liveness_note:
        'A gauge reading as at the moment of the call. A tank with a non-zero flow_rate_tph is being ' +
        'filled or drawn down right now and its figure is already out of date; level_movement says which ' +
        'direction. Quote a moving tank with the time, not as a standing balance.',
    };

    if (tanks.length === 0) {
      data.empty_result_note =
        all.length === 0
          ? 'JPS returned no tanks for this port at all. That is a real empty result - the gauge feed was ' +
            'read successfully - but an entire tank farm reading empty is worth checking on the JPS page ' +
            'before reporting it.'
          : `No tank matched the filter, though ${String(all.length)} exist at this port. Check the ` +
            'product or tank spelling against by_product on an unfiltered call.';
    }

    return {
      data,
      // JPS does not label the volume and mass columns, so no unit is claimed for the
      // payload. units_note carries what the data itself implies.
      units: null,
      rowCount: tanks.length,
      truncated: matched.length > tanks.length,
      asOf: new Date(),
      system: 'jetty',
      klipCalls: calls,
    };
  },
};

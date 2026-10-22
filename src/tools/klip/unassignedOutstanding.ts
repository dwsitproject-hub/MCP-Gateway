/**
 * klip_unassigned_outstanding - "how much outstanding quantity has no vessel yet", per plant.
 *
 * Totalled HERE from the rows KLIP's Shipping Performance endpoint already returns (the
 * route klip_shipping_performance uses, verified 14 Sep 2026), with no new request option:
 *
 *   NOT ON ANY SHIPMENT - KLIP appends one row per contract that has outstanding and no
 *     shipment at all (its "backlog arm": status UNPLANNED, no vessel, one row per contract,
 *     outstanding_qty = the contract's remaining outstanding; Logistic SAP
 *     shippingPerformance.service.ts buildShippingPerformanceBacklogSql). Summable.
 *   ON A SHIPMENT WITH NO VESSEL - open shipment rows whose vessel_name is empty. Their
 *     sto_qty is summed, NOT outstanding_qty: on shipment rows outstanding is the CONTRACT's,
 *     repeated on every STO of the contract, so summing it would count a contract once per STO.
 *
 * KLIP's Shipments page "Unplanned" card is computed by a different query and can differ;
 * this is what the Shipping Performance data says. The endpoint applies its own default
 * window (the page's), which this connector cannot change.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { kgToMt } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const inputShape = {
  product: z.string().min(1).optional().describe('Product, e.g. "CPO". Omit for all products.'),
  plant: z.string().min(1).optional().describe('Plant as klip_reference reports it. Omit for every plant.'),
};

const round = (n: number): number => Math.round(n * 1000) / 1000;

export const unassignedOutstanding: ToolDefinition<typeof inputShape> = {
  name: 'klip_unassigned_outstanding',
  title: 'KLIP outstanding with no vessel yet, per plant',
  cap: 100,
  description: describe(
    'Outstanding quantity (MT) that has NO VESSEL yet, per plant, largest first, in two parts: contracts with no ' +
      'shipment at all (their remaining outstanding), and shipments planned without a vessel (their STO quantity). ' +
      'Also the suppliers with the most outstanding not on any shipment. Filter by product and plant. ' +
      'Totalled by this connector from KLIP\'s Shipping Performance data; KLIP\'s Shipments page Unplanned card is ' +
      'computed differently and can differ.',
    'Returns every plant with quantity.',
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.shippingPerformance;
    const f = fields.shippingPerformance;
    const filters = buildFilters(route, { plant: params.plant });
    // Same walk and cache key as klip_shipping_performance: one fetch serves both tools.
    const cached = await cache.through(
      cache.keyFor('klip_shipping_performance', { plant: params.plant }),
      async () => walk<Row>({ route, filters: filters.upstream, maxPages: 1 }),
    );
    const walked = cached.value;

    const plants = new Map<string, { not_on_any_shipment_mt: number; contracts: number; on_shipment_without_vessel_mt: number; shipments_without_vessel: number }>();
    const suppliers = new Map<string, number>();
    for (const row of walked.rows) {
      if (!matchesLoosely(pickString(row, f.product), params.product)) continue;
      const status = (pickString(row, f.status) ?? '').toUpperCase();
      if (status === 'COMPLETED') continue;
      const plant = pickString(row, f.plant) ?? '(no plant)';
      const p = plants.get(plant) ?? { not_on_any_shipment_mt: 0, contracts: 0, on_shipment_without_vessel_mt: 0, shipments_without_vessel: 0 };
      const vessel = (pickString(row, f.vesselName) ?? '').trim();
      if (status === 'UNPLANNED' && vessel === '') {
        const os = kgToMt(pickNumber(row, f.outstandingQty)) ?? 0;
        if (os <= 0) continue;
        p.not_on_any_shipment_mt += os;
        p.contracts += 1;
        const s = pickString(row, f.supplier) ?? '(no supplier)';
        suppliers.set(s, (suppliers.get(s) ?? 0) + os);
      } else if (vessel === '') {
        const sto = kgToMt(pickNumber(row, f.stoQty)) ?? 0;
        if (sto <= 0) continue;
        p.on_shipment_without_vessel_mt += sto;
        p.shipments_without_vessel += 1;
      } else continue;
      plants.set(plant, p);
    }

    const perPlant = [...plants.entries()]
      .map(([plant, p]) => ({
        plant,
        without_vessel_mt: round(p.not_on_any_shipment_mt + p.on_shipment_without_vessel_mt),
        not_on_any_shipment_mt: round(p.not_on_any_shipment_mt),
        contracts_not_on_any_shipment: p.contracts,
        on_shipment_without_vessel_mt: round(p.on_shipment_without_vessel_mt),
        shipments_without_vessel: p.shipments_without_vessel,
      }))
      .filter((p) => p.without_vessel_mt > 0)
      .sort((a, b) => b.without_vessel_mt - a.without_vessel_mt);
    const total = perPlant.reduce((s, p) => s + p.without_vessel_mt, 0);

    const data: Record<string, unknown> = {
      filter: { product: params.product ?? 'all', plant: params.plant ?? 'all' },
      total_without_vessel_mt: round(total),
      plants: perPlant,
      top_suppliers_not_on_any_shipment: [...suppliers.entries()].map(([supplier, mt]) => ({ supplier, outstanding_mt: round(mt) })).sort((a, b) => b.outstanding_mt - a.outstanding_mt).slice(0, 10),
      method:
        'Totalled by this connector from KLIP Shipping Performance rows: contracts with no shipment (KLIP marks them ' +
        'UNPLANNED, one row each, with their remaining outstanding) plus the STO quantity of open shipments with no ' +
        'vessel named. Completed shipments are excluded. Outstanding on shipment rows is never summed - it repeats per STO.',
      differs_from: 'KLIP\'s Shipments page Unplanned card is a different query and can show a different figure.',
    };
    if (perPlant.length === 0) data.empty_result_note = 'No outstanding without a vessel for this filter in the Shipping Performance data.';

    return {
      data,
      units: 'MT',
      rowCount: perPlant.length,
      truncated: false,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      klipCalls: walked.calls,
    };
  },
};

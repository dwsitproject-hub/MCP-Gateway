/**
 * klip_get_contract - "Status of contract 4700012345?"  (PRD U2)
 *
 * The multi-endpoint join. Two behaviours matter:
 *   - A missing contract returns a typed NOT_FOUND error, so the model says
 *     "not found" and cannot invent a record (UAT U2).
 *   - The linked lookups (shipments, trucking, payments) are best-effort: if one
 *     sub-fetch fails the contract header is still returned, with the failure named
 *     in the payload rather than silently rendered as an empty list.
 */
/**
 * WHICH ENDPOINT IS AUTHORITATIVE - answered by the KLIP team, 28 Aug 2026.
 *
 * getContract upstream is literally `SELECT * FROM contracts WHERE id = $1`: no joins,
 * no derivations, no normalisation, and no business exclusions - because it applies
 * nothing at all. That single fact explains every disagreement we had logged between
 * this endpoint and the list, and none of them is a conflict:
 *
 *   plant     list "Cisadane"  detail "CD2A"   group and member - master_plants.group_plant
 *                                              resolved from plant_code
 *   status    list "Open"      detail "ACTIVE" different COLUMNS: the list surfaces
 *                                              import_status (SAP-derived, normalised to
 *                                              Open/Close), the detail the raw lifecycle
 *                                              column, whose CHECK permits exactly
 *                                              Open, Close, Cancelled, ACTIVE, COMPLETED,
 *                                              CANCELLED. KLIP treats ACTIVE as OPEN and
 *                                              COMPLETED as CLOSE throughout.
 *   shipped   list 0           detail null     computed by the list; the column does not
 *                                              exist on the row, so null is honest here
 *                                              and 0 would be a lie
 *
 * So: THE LIST IS AUTHORITATIVE FOR ANYTHING DERIVED - shipped, received, outstanding,
 * normalised status, group plant. The detail answers "what is stored", the list answers
 * "what is reportable". A contract fetchable by id and absent from every list is expected
 * behaviour rather than a leak.
 */
import { z } from 'zod';
import { dig, fetchEnvelope, walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import {
  deviationDays,
  gainLossKg,
  kgToMt,
  outstanding as outstandingFor,
  toDateOnly,
  toWibIso,
} from './../../adapters/klip/normalize.js';
import { notFound } from './../../core/errors.js';
import type { CallRecord } from './../../adapters/klip/session.js';
import { logger } from './../../core/logger.js';
import { toContractLine } from './searchContracts.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const LINKED_CAP = 10;

const inputShape = {
  contract_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._\-/]+$/, 'contract id may contain letters, digits, dot, dash, underscore and slash only')
    .describe('Exact KLIP contract id or PO number. No fuzzy matching is performed.'),
};

/**
 * The derived quantities, fetched from the endpoint that actually computes them.
 *
 * Measured across ten different contracts on 14 Sep 2026: /contracts/:id returns 37
 * fields and NONE of them is quantity_delivery, quantity_receive or
 * outstanding_quantity. That is not a mapping error - the KLIP team told us on
 * 28 Aug that the detail endpoint is `SELECT * FROM contracts WHERE id = $1` and
 * derives nothing, so the columns genuinely do not exist on the row.
 *
 * Null was the honest answer while nothing better was available. It is no longer the
 * best one: the LIST computes these fields, the header note above already records it
 * as authoritative for them, and the Contracts page shows them - so a lookup that
 * answers "shipped: unknown" disagrees with KLIP's own UI about a number KLIP holds.
 * One extra filtered call closes that gap without deriving anything here.
 *
 * Best-effort like the other linked fetches: a failure names itself and the header
 * still returns, because a missing quantity must never take down the whole contract.
 */
async function derivedQuantities(
  contractId: string,
  calls: CallRecord[],
  failures: string[],
): Promise<Row | undefined> {
  const search = (routes.contracts.params as { search?: string }).search;
  if (search === undefined) return undefined;
  try {
    const walked = await walk<Row>({
      route: routes.contracts,
      filters: { [search]: contractId },
      maxPages: 1,
      calls,
    });
    // `search` is a contains-match upstream, so it can return neighbours. Take the row
    // whose id actually equals the one we resolved, never merely the first one back.
    return walked.rows.find(
      (r) => String(r['contract_id'] ?? '') === contractId || String(r['id'] ?? '') === contractId,
    );
  } catch (err) {
    logger.warn({ contractId, err: (err as Error).message }, 'derived-quantity lookup failed');
    failures.push(
      `derived quantities: not retrieved (${(err as Error).message}). Shipped, received and outstanding ` +
        'are reported as unknown below - that is a fetch failure, NOT a zero.',
    );
    return undefined;
  }
}

/** Fetch a linked list without letting one failure take down the whole answer. */
async function linked(
  label: string,
  contractId: string,
  route: (typeof routes)['shipments' | 'trucking' | 'payments'],
  calls: CallRecord[],
  failures: string[],
): Promise<Row[]> {
  // Only /finance/payments accepts a contract filter, and it spells it contract_id.
  // /shipments and /trucking ignore contractId entirely and would return EVERY row,
  // which this lookup would then present as "linked to your contract". Reporting the
  // limitation is the only honest option until the join field on each row is known.
  const param = (route.params as { contractId?: string }).contractId;
  if (param === undefined) {
    failures.push(
      `${label}: this connector has no contract filter configured for that endpoint, so linked ${label} ` +
        `are not listed here. Query the ${label} tool directly. This is a connector limitation, not a ` +
        `statement that none exist.`,
    );
    return [];
  }
  try {
    const walked = await walk<Row>({
      route,
      filters: { [param]: contractId },
      maxPages: 1,
      calls,
    });
    return walked.rows;
  } catch (err) {
    logger.warn({ label, err: (err as Error).message }, 'linked lookup failed');
    failures.push(`${label}: not retrieved (${(err as Error).message})`);
    return [];
  }
}

export const getContract: ToolDefinition<typeof inputShape> = {
  name: 'klip_get_contract',
  title: 'Get one KLIP contract',
  cap: LINKED_CAP,
  description: describe(
    'Full detail for ONE contract identified exactly: header fields, outstanding quantity on the Incoterm-correct ' +
      'basis, plus its linked shipments, trucking sequences and payments. ' +
      'If the contract does not exist this returns a NOT_FOUND error - report that plainly and never invent a record.',
    `Returns one contract with at most ${LINKED_CAP} rows in each linked list.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const calls: CallRecord[] = [];
    const failures: string[] = [];
    const id = params.contract_id;
    const asOf = new Date();

    // Fetch the whole envelope once: /contracts/:id carries the record, its linked
    // shipments and payments, and the match metadata, all in one response.
    const envelope = await fetchEnvelope(
      `${routes.contractById.path.replace(':id', encodeURIComponent(id))}`,
      calls,
    );
    if (envelope === undefined) throw notFound(`Contract "${id}"`);

    const header = dig(envelope, routes.contractById.rowsPath) as Row | undefined;
    if (header === undefined || Object.keys(header).length === 0) {
      throw notFound(`Contract "${id}"`);
    }

    /**
     * A PO number can span several contracts under multi-STO. KLIP resolves one
     * deterministically - exact contract number first, then newest - so a match_count
     * above 1 means the record below is ONE OF SEVERAL. Presenting it as the answer
     * would be a quiet lie about a lookup the user believes was exact.
     */
    const matchCount = dig(envelope, 'data.match_count');
    const matchedBy = dig(envelope, 'data.matched_by');
    const ambiguous = typeof matchCount === 'number' && matchCount > 1;

    // Shipments and payments arrive INLINE. Only trucking needs its own call.
    const inlineShipments = dig(envelope, 'data.shipments');
    const inlinePayments = dig(envelope, 'data.payments');

    const resolvedId = String(header['contract_id'] ?? id);
    const [linkedShipments, truckingRows, linkedPayments, listRow] = await Promise.all([
      Array.isArray(inlineShipments)
        ? Promise.resolve(inlineShipments as Row[])
        : linked('shipments', id, routes.shipments, calls, failures),
      linked('trucking', id, routes.trucking, calls, failures),
      Array.isArray(inlinePayments)
        ? Promise.resolve(inlinePayments as Row[])
        : linked('payments', id, routes.payments, calls, failures),
      derivedQuantities(resolvedId, calls, failures),
    ]);

    /**
     * Merge, but only where the detail row is SILENT. Overwriting a field the detail
     * does carry would quietly swap one endpoint's answer for another's, and the two
     * disagree on purpose - the detail says what is stored, the list what is
     * reportable. Only the three genuinely absent keys are taken.
     */
    const merged: Row = { ...header };
    let quantitiesFromList = false;
    for (const key of ['quantity_delivery', 'quantity_receive', 'outstanding_quantity']) {
      if (!(key in merged) && listRow !== undefined && key in listRow) {
        merged[key] = listRow[key];
        quantitiesFromList = true;
      }
    }
    const line = outstandingFor(toContractLine(merged));
    const shipmentRows = linkedShipments;
    const paymentRows = linkedPayments;

    const shipments = shipmentRows.slice(0, LINKED_CAP).map((row) => ({
      sto_number: pickString(row, fields.shipment.stoNumber),
      vessel_name: pickString(row, fields.shipment.vesselName),
      status: pickString(row, fields.shipment.status),
      loading_port: pickString(row, fields.shipment.loadingPort),
      discharge_port: pickString(row, fields.shipment.dischargePort),
      // Named for the MILESTONE, not as an ETA/ETD pair. KLIP models a ladder -
      // arrive at the loading port, berth, load, sail, then the discharge side - and
      // squeezing it into "ETD/ETA" made arrival-at-loading look like a destination ETA
      // sitting BEFORE its own departure. That was reported as a KLIP column swap; it
      // was this mapping. See fields.shipment.
      // DATE COLUMNS, so date-only. Confirmed by the KLIP team, 28 Aug 2026: these are
      // PostgreSQL DATE values, which carry no time and no zone. The driver parses one at
      // local midnight, the container is UTC, and JSON.stringify appends the Z - so
      // 2026-07-15T00:00:00.000Z is the exact calendar date and nothing else. Converting
      // it to WIB would attach a time that was never recorded, and any backward shift
      // would move the date to the previous day. Read the date part and discard the rest.
      eta_loading_arrival: toDateOnly(pickString(row, fields.shipment.etaLoadArrival)),
      eta_sailed_from_loading: toDateOnly(pickString(row, fields.shipment.etaSailed)),
      eta_discharge_arrival: toDateOnly(pickString(row, fields.shipment.etaDischArrival)),
      eta_discharge_complete: toDateOnly(pickString(row, fields.shipment.etaDischComplete)),
      ata_loading_arrival: toDateOnly(pickString(row, fields.shipment.ataLoadArrival)),
      ata_sailed_from_loading: toDateOnly(pickString(row, fields.shipment.ataSailed)),
      ata_discharge_arrival: toDateOnly(pickString(row, fields.shipment.ataDischArrival)),
      ata_discharge_complete: toDateOnly(pickString(row, fields.shipment.ataDischComplete)),
      qty_mt: kgToMt(pickNumber(row, fields.shipment.qty)),
    }));

    const trucking = truckingRows.slice(0, LINKED_CAP).map((row) => {
      // KLIP's vocabulary (KLIP-004): delivered = dispatched from origin,
      // receive = weighed in at destination. Kilograms on this endpoint.
      const dispatched = pickNumber(row, fields.trucking.dispatched);
      const received = pickNumber(row, fields.trucking.received);
      return {
        sent_date: toDateOnly(pickString(row, fields.trucking.sentDate)),
        delivered_date: toDateOnly(pickString(row, fields.trucking.deliveredDate)),
        dispatched_mt: kgToMt(dispatched),
        received_mt: kgToMt(received),
        gain_loss_mt: kgToMt(gainLossKg(dispatched, received)),
      };
    });

    const payments = paymentRows.slice(0, LINKED_CAP).map((row) => {
      const due = pickString(row, fields.payment.dueDate);
      const paid = pickString(row, fields.payment.paidDate);
      const reported = pickNumber(row, fields.payment.deviationDays);
      return {
        invoice_number: pickString(row, fields.payment.invoiceNumber),
        invoice_date: toDateOnly(pickString(row, fields.payment.invoiceDate)),
        due_date: toDateOnly(due),
        paid_date: toDateOnly(paid),
        status: pickString(row, fields.payment.status),
        amount: pickNumber(row, fields.payment.amount),
        currency: pickString(row, fields.payment.currency) ?? 'IDR',
        deviation_days: reported ?? deviationDays(due, paid),
      };
    });

    const data: Record<string, unknown> = {
      contract: {
        contract_id: line.contract_id,
        po_number: line.po_number,
        supplier: line.supplier,
        product: line.product,
        plant: line.plant,
        incoterm: line.incoterm,
        status: line.status,
        contract_date: toDateOnly(pickString(header, fields.contract.contractDate)),
        qty_po_mt: kgToMt(line.qty_po_kg),
        shipped_mt: kgToMt(pickNumber(merged, fields.contract.shipped)),
        received_mt: kgToMt(pickNumber(merged, fields.contract.received)),
        outstanding_mt: kgToMt(line.outstanding_kg),
        outstanding_basis: line.basis,
        unit_price: pickNumber(merged, fields.contract.unitPrice),
        contract_value: pickNumber(merged, fields.contract.contractValue),
        currency: pickString(merged, fields.contract.currency),
        data_quality: line.data_quality,
      },
      shipments,
      trucking,
      payments,
      quantities_note: quantitiesFromList
        ? 'Payment amounts are currency values and are NOT converted; only quantities are in MT. ' +
          'shipped_mt, received_mt and outstanding_mt come from KLIP\'s CONTRACTS LIST, which computes them - ' +
          'the detail record does not store those columns at all. This is the same figure the KLIP Contracts ' +
          'page shows, not a second calculation.'
        : 'Payment amounts are currency values and are NOT converted; only quantities are in MT. ' +
          'shipped_mt, received_mt and outstanding_mt are UNKNOWN here: the detail record does not store them ' +
          'and the contracts list did not return this contract. Unknown is not zero - check the KLIP ' +
          'Contracts page before reporting a quantity.',
      price_note:
        'unit_price and contract_value are KLIP\'s own figures, in `currency`. This connector does NOT ' +
        'multiply price by quantity: quantities are stored in KILOGRAMS behind a unit field that reads MT ' +
        'or KG depending on the endpoint, and KLIP does not state whether unit_price is per kilogram or ' +
        'per tonne - the two readings differ by a factor of 1000. contract_value is the total KLIP itself ' +
        'computed, so quote that rather than deriving one. If a figure for a partial quantity is needed, ' +
        'ask KLIP what basis unit_price uses before calculating anything.',
      remarks_note:
        'KLIP exposes no remark TEXT through its API. The contracts list carries a remarks_count only, and the ' +
        'detail record carries neither (measured across ten contracts, 14 Sep 2026), so remarks are not ' +
        'reported rather than reported as empty.',
    };

    if (ambiguous) {
      data.match_warning =
        `The identifier "${id}" matched ${String(matchCount)} contracts in KLIP. The record above is the one ` +
        'KLIP resolved (exact contract number first, then newest), NOT the only match. Report it as one of ' +
        'several and ask the user which contract they mean before quoting its figures.';
    }
    if (typeof matchedBy === 'string') data.matched_by = matchedBy;
    if (typeof matchCount === 'number') data.match_count = matchCount;

    if (failures.length > 0) {
      data.incomplete_sections = failures;
      data.incomplete_note =
        'One or more linked sections could not be retrieved. An empty list above may mean "not retrieved" rather ' +
        'than "none exist" - say so rather than reporting zero.';
    }
    if (shipmentRows.length > LINKED_CAP || truckingRows.length > LINKED_CAP || paymentRows.length > LINKED_CAP) {
      data.linked_truncated_note = `Linked lists are capped at ${LINKED_CAP} rows each; more exist in KLIP.`;
    }

    return {
      data,
      units: 'MT',
      rowCount: 1,
      truncated:
        shipmentRows.length > LINKED_CAP || truckingRows.length > LINKED_CAP || paymentRows.length > LINKED_CAP,
      asOf,
      klipCalls: calls,
    };
  },
};

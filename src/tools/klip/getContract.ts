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

    const line = outstandingFor(toContractLine(header));

    // Shipments and payments arrive INLINE. Only trucking needs its own call.
    const inlineShipments = dig(envelope, 'data.shipments');
    const inlinePayments = dig(envelope, 'data.payments');

    const [linkedShipments, truckingRows, linkedPayments] = await Promise.all([
      Array.isArray(inlineShipments)
        ? Promise.resolve(inlineShipments as Row[])
        : linked('shipments', id, routes.shipments, calls, failures),
      linked('trucking', id, routes.trucking, calls, failures),
      Array.isArray(inlinePayments)
        ? Promise.resolve(inlinePayments as Row[])
        : linked('payments', id, routes.payments, calls, failures),
    ]);
    const shipmentRows = linkedShipments;
    const paymentRows = linkedPayments;

    const shipments = shipmentRows.slice(0, LINKED_CAP).map((row) => ({
      sto_number: pickString(row, fields.shipment.stoNumber),
      vessel_name: pickString(row, fields.shipment.vesselName),
      status: pickString(row, fields.shipment.status),
      loading_port: pickString(row, fields.shipment.loadingPort),
      discharge_port: pickString(row, fields.shipment.dischargePort),
      etd: toWibIso(pickString(row, fields.shipment.etd)),
      eta: toWibIso(pickString(row, fields.shipment.eta)),
      atd: toWibIso(pickString(row, fields.shipment.atd)),
      ata: toWibIso(pickString(row, fields.shipment.ata)),
      qty_mt: kgToMt(pickNumber(row, fields.shipment.qty)),
    }));

    const trucking = truckingRows.slice(0, LINKED_CAP).map((row) => {
      // KLIP's vocabulary (KLIP-004): delivered = dispatched from origin,
      // receive = weighed in at destination. Kilograms on this endpoint.
      const dispatched = pickNumber(row, fields.trucking.dispatched);
      const received = pickNumber(row, fields.trucking.received);
      return {
        sequence: pickString(row, fields.trucking.sequence),
        truck_number: pickString(row, fields.trucking.truckNumber),
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
        shipped_mt: kgToMt(pickNumber(header, fields.contract.shipped)),
        received_mt: kgToMt(pickNumber(header, fields.contract.received)),
        outstanding_mt: kgToMt(line.outstanding_kg),
        outstanding_basis: line.basis,
        remarks: pickString(header, fields.contract.remarks),
        data_quality: line.data_quality,
      },
      shipments,
      trucking,
      payments,
      quantities_note: 'Payment amounts are currency values and are NOT converted; only quantities are in MT.',
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

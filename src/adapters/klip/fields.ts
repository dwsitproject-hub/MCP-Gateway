/**
 * ===================================================================
 * TSD APPENDIX A (part 2) - KLIP RESPONSE FIELD MAP
 * ===================================================================
 *
 * Companion to routes.ts. Where routes.ts pins paths and query parameters, this
 * file pins the field names inside KLIP response rows.
 *
 * Every entry lists candidate spellings in priority order because the field names
 * are UNVERIFIED until P1 reconciliation. Once Swagger is read, cut each list down
 * to the single verified name - a shrinking list is the measure of progress here.
 *
 * `pickNumber` deliberately returns null for absent/unparseable values rather than
 * 0, so the normalizer's null-propagation rule (T-7) is never undermined by the
 * reader below it.
 */

export type Row = Record<string, unknown>;

/** First candidate present (not null/undefined/empty-string) wins. */
export function pick(row: Row | undefined, candidates: readonly string[]): unknown {
  if (row === undefined || row === null) return undefined;
  for (const key of candidates) {
    const value = key.includes('.') ? dig(row, key) : row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function dig(row: Row, path: string): unknown {
  let cursor: unknown = row;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Row)[segment];
  }
  return cursor;
}

export function pickString(row: Row | undefined, candidates: readonly string[]): string | null {
  const value = pick(row, candidates);
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Numeric read that tolerates KLIP returning quantities as strings, including
 * thousands separators. Returns null - never 0 - when the value is absent or junk.
 */
export function pickNumber(row: Row | undefined, candidates: readonly string[]): number | null {
  const value = pick(row, candidates);
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[\s,_]/g, '');
    if (cleaned === '' || !Number.isFinite(Number(cleaned))) return null;
    return Number(cleaned);
  }
  return null;
}

export function pickArray(row: Row | undefined, candidates: readonly string[]): Row[] {
  const value = pick(row, candidates);
  return Array.isArray(value) ? (value as Row[]) : [];
}

/**
 * Field candidates. UNVERIFIED - see the header.
 */
export const fields = {
  contract: {
    id: ['id', 'contractId', 'contract_id', 'contractNo', 'no_kontrak'],
    // KLIP spells it PLURAL. A contract can carry several POs.
    poNumber: ['po_numbers', 'poNumber', 'po_number', 'contract_ext_no', 'contract_reference_po', 'poNo'],
    supplier: ['supplier', 'supplierName', 'supplier_name', 'vendor', 'nama_supplier'],
    product: ['product', 'productName', 'product_name', 'commodity', 'produk'],
    plant: ['plant_site', 'plant_code', 'plant', 'plantName', 'plant_name', 'location'],
    incoterm: ['incoterm', 'incoTerm', 'inco_term', 'terms', 'syarat_penyerahan'],
    status: ['status', 'contractStatus', 'contract_status', 'statusKontrak'],
    /**
      * VERIFIED 2026-08-21 against live rows. The names assumed here originally
      * (qtyPo / totalKirim / totalTerima) do not exist in KLIP, so every quantity read
      * as null and every contract was flagged missing_qty_po - while the totals still
      * printed "0 outstanding", which reads as a fact rather than as no-data.
      *
      * Rows carry their own `unit` field, observed as "MT". That CONTRADICTS the TSD's
      * kg-labelled-as-MT warning for this endpoint; honour the row's unit, do not
      * assume either way.
      */
    qtyPo: ['quantity_ordered', 'qtyPo', 'qty_po', 'quantityPo'],
    shipped: ['quantity_delivery', 'qtyShipped', 'qty_shipped', 'shippedQty'],
    received: ['quantity_receive', 'qtyReceived', 'qty_received', 'receivedQty'],
    /** KLIP computes this itself - useful as a cross-check on our own arithmetic. */
    outstandingUpstream: ['outstanding_quantity'],
    /** Per-row unit of measure. Observed "MT" on contracts. */
    unit: ['unit', 'uom', 'unitOfMeasure'],
    contractDate: ['contractDate', 'contract_date', 'tanggalKontrak', 'date'],
    remarks: ['remarks', 'remark', 'notes', 'keterangan'],
  },

  shipment: {
    id: ['id', 'shipmentId', 'shipment_id'],
    stoNumber: ['stoNumber', 'sto_number', 'sto', 'stoNo'],
    contractId: ['contractId', 'contract_id', 'contract.id'],
    vesselName: ['vesselName', 'vessel_name', 'vessel', 'namaKapal'],
    loadingPort: ['port_of_loading', 'loadingPort', 'loading_port', 'portLoading'],
    dischargePort: ['port_of_discharge', 'dischargePort', 'discharge_port', 'portDischarge'],
    status: ['status', 'shipmentStatus', 'shipment_status'],
    // KLIP exposes a whole eta_* ladder (arrival, berthed, loading_start,
    // loading_complete, sailed, then the discharge-side equivalents) rather than a
    // plain ETD/ETA pair. These map the nearest equivalent; the ladder is richer than
    // the four fields this tool reports and is worth revisiting.
    etd: ['eta_sailed', 'etd', 'ETD', 'estimatedDeparture'],
    eta: ['eta_arrival', 'eta', 'ETA', 'estimatedArrival'],
    atd: ['shipment_date', 'atd', 'ATD', 'actualDeparture'],
    ata: ['arrival_date', 'ata', 'ATA', 'actualArrival'],
    qty: ['quantity_shipped', 'quantity_delivered', 'qty', 'quantity'],
  },

  trucking: {
    id: ['id', 'truckingId', 'trucking_id'],
    sequence: ['sequence', 'seq', 'urutan', 'sequenceNo'],
    contractId: ['contractId', 'contract_id'],
    plant: ['location', 'loading_location', 'plant', 'plantName'],
    sentDate: ['trucking_start_date', 'realization_start_date', 'sentDate', 'sent_date'],
    deliveredDate: ['trucking_completion_date', 'realization_end_date', 'deliveredDate', 'delivered_date'],
    qtySent: ['quantity_sent', 'qtySent', 'qty_sent'],
    qtyDelivered: ['quantity_delivered', 'qtyDelivered', 'qty_delivered'],
    /**
      * NOT PRESENT on live rows. /trucking returns OPERATIONS, not individual truck
      * movements, so there is no plate number to report. Left in place so the reader
      * returns null rather than inventing one; the tool description should not promise it.
      */
    truckNumber: ['truckNumber', 'truck_number', 'plateNumber'],
  },

  quality: {
    id: ['id', 'qualityId', 'surveyId'],
    shipmentId: ['shipmentId', 'shipment_id'],
    contractId: ['contractId', 'contract_id'],
    stoNumber: ['stoNumber', 'sto_number', 'sto'],
    location: ['location', 'surveyLocation', 'point', 'lokasi'],
    surveyDate: ['surveyDate', 'survey_date', 'tanggalSurvey', 'date'],
    surveyor: ['surveyor', 'surveyorName', 'inspector'],
    ffa: ['ffa', 'FFA', 'ffaValue'],
    mi: ['mi', 'MI', 'mAndI', 'm_and_i', 'moistureImpurities'],
    iv: ['iv', 'IV', 'iodineValue'],
    dobi: ['dobi', 'DOBI', 'dobiValue'],
  },

  payment: {
    id: ['id', 'paymentId', 'payment_id'],
    contractId: ['contractId', 'contract_id'],
    invoiceNumber: ['invoiceNumber', 'invoice_number', 'noInvoice'],
    invoiceDate: ['invoiceDate', 'invoice_date', 'tanggalInvoice'],
    dueDate: ['dueDate', 'due_date', 'tanggalJatuhTempo', 'jatuhTempo'],
    paidDate: ['paidDate', 'paid_date', 'tanggalBayar', 'datePaid'],
    status: ['status', 'paymentStatus', 'payment_status'],
    amount: ['amount', 'amountIdr', 'nilai', 'total'],
    currency: ['currency', 'curr', 'matauang'],
    deviationDays: ['deviationDays', 'deviation_days', 'deviasiHari'],
  },

  sapImport: {
    id: ['id', 'importId', 'import_id', 'batchId'],
    // VERIFIED 2026-08-21. KLIP returns exactly: id, import_date, import_timestamp,
    // status, total_records, processed_records, failed_records.
    startedAt: ['import_timestamp', 'import_date', 'startedAt', 'started_at'],
    /** NOT PRESENT - KLIP reports no completion time. Always null; do not imply duration. */
    finishedAt: ['finishedAt', 'finished_at', 'completedAt'],
    status: ['status', 'importStatus', 'import_status'],
    rowsProcessed: ['processed_records', 'total_records', 'rowsProcessed', 'rows_processed'],
    rowsFailed: ['failed_records', 'rowsFailed', 'rows_failed'],
    /** NOT PRESENT on live rows. */
    fileName: ['fileName', 'file_name', 'file'],
    /** NOT PRESENT on live rows. */
    message: ['message', 'errorMessage', 'error_message'],
  },
} as const;

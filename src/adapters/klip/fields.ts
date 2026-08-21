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
    poNumber: ['poNumber', 'po_number', 'poNo', 'no_po'],
    supplier: ['supplier', 'supplierName', 'supplier_name', 'vendor', 'nama_supplier'],
    product: ['product', 'productName', 'product_name', 'commodity', 'produk'],
    plant: ['plant', 'plantName', 'plant_name', 'location', 'pabrik'],
    incoterm: ['incoterm', 'incoTerm', 'inco_term', 'terms', 'syarat_penyerahan'],
    status: ['status', 'contractStatus', 'contract_status', 'statusKontrak'],
    // Quantities in KILOGRAMS (kg-labelled-as-MT trap).
    qtyPo: ['qtyPo', 'qty_po', 'quantityPo', 'qtyKontrak', 'qty_kontrak', 'volume'],
    shipped: ['totalKirim', 'total_kirim', 'qtyShipped', 'qty_shipped', 'shippedQty'],
    received: ['totalTerima', 'total_terima', 'qtyReceived', 'qty_received', 'receivedQty'],
    contractDate: ['contractDate', 'contract_date', 'tanggalKontrak', 'date'],
    remarks: ['remarks', 'remark', 'notes', 'keterangan'],
  },

  shipment: {
    id: ['id', 'shipmentId', 'shipment_id'],
    stoNumber: ['stoNumber', 'sto_number', 'sto', 'stoNo'],
    contractId: ['contractId', 'contract_id', 'contract.id'],
    vesselName: ['vesselName', 'vessel_name', 'vessel', 'namaKapal'],
    loadingPort: ['loadingPort', 'loading_port', 'portLoading', 'pelabuhanMuat'],
    dischargePort: ['dischargePort', 'discharge_port', 'portDischarge', 'pelabuhanBongkar'],
    status: ['status', 'shipmentStatus', 'shipment_status'],
    etd: ['etd', 'ETD', 'estimatedDeparture'],
    eta: ['eta', 'ETA', 'estimatedArrival'],
    atd: ['atd', 'ATD', 'actualDeparture'],
    ata: ['ata', 'ATA', 'actualArrival'],
    qty: ['qty', 'quantity', 'qtyKirim', 'qty_kirim', 'volume'],
  },

  trucking: {
    id: ['id', 'truckingId', 'trucking_id'],
    sequence: ['sequence', 'seq', 'urutan', 'sequenceNo'],
    contractId: ['contractId', 'contract_id'],
    plant: ['plant', 'plantName', 'location'],
    sentDate: ['sentDate', 'sent_date', 'tanggalKirim', 'dateSent'],
    deliveredDate: ['deliveredDate', 'delivered_date', 'tanggalTerima', 'dateDelivered'],
    qtySent: ['qtySent', 'qty_sent', 'qtyKirim', 'qty_kirim'],
    qtyDelivered: ['qtyDelivered', 'qty_delivered', 'qtyTerima', 'qty_terima'],
    truckNumber: ['truckNumber', 'truck_number', 'noPolisi', 'plateNumber'],
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
    startedAt: ['startedAt', 'started_at', 'importDate', 'import_date', 'createdAt'],
    finishedAt: ['finishedAt', 'finished_at', 'completedAt'],
    status: ['status', 'importStatus', 'import_status', 'result'],
    rowsProcessed: ['rowsProcessed', 'rows_processed', 'processed', 'totalRows', 'recordsProcessed'],
    rowsFailed: ['rowsFailed', 'rows_failed', 'failed', 'errorCount', 'recordsFailed'],
    fileName: ['fileName', 'file_name', 'file', 'source'],
    message: ['message', 'errorMessage', 'error_message', 'detail', 'note'],
  },
} as const;

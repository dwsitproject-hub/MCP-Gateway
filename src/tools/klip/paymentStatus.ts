/**
 * klip_payment_status - "Which payments are overdue this week?"  (PRD U3)
 *
 * Amounts are currency values and are never unit-converted. Deviation days come
 * from KLIP when KLIP reports them, and are otherwise derived from due versus paid
 * date - with the derivation declared, so a Finance user knows which they are
 * looking at.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { deviationDays, toDateOnly } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { buildFilters, isoDate, localFilterNote, matchesLoosely } from './common.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 50;

const inputShape = {
  status: z
    .enum(['overdue', 'due', 'paid', 'any'])
    .default('any')
    .describe('Payment state to filter on. "overdue" means unpaid with a due date in the past.'),
  contract_id: z.string().min(1).optional().describe('Contract id.'),
  date_from: isoDate.optional().describe('Earliest due date to include.'),
  date_to: isoDate.optional().describe('Latest due date to include.'),
  limit: z.number().int().min(1).max(CAP).default(25).describe(`How many payment rows to return (max ${CAP}).`),
};

const today = (): string => new Date(Date.now() + 7 * 60 * 60_000).toISOString().slice(0, 10);

export const paymentStatus: ToolDefinition<typeof inputShape> = {
  name: 'klip_payment_status',
  title: 'KLIP payment status',
  cap: CAP,
  description: describe(
    'Payment records with invoice, due and paid dates, status, amount and deviation days (paid date minus due date; ' +
      'positive means late). Use status="overdue" for the unpaid-and-past-due list. ' +
      'Amounts are currency values, reported in the currency KLIP holds, and are never converted.',
    `Returns at most ${CAP} rows plus aggregates over every matching row fetched.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.payments;
    const limit = Math.min(params.limit, CAP);

    // "overdue" is a gateway-side notion; only a concrete status is worth sending upstream.
    const upstreamStatus = params.status === 'paid' || params.status === 'due' ? params.status : undefined;
    const filterInput = {
      status: upstreamStatus,
      contract_id: params.contract_id,
      date_from: params.date_from,
      date_to: params.date_to,
    };
    const filters = buildFilters(route, filterInput);

    const cached = await cache.through(
      cache.keyFor('klip_payment_status', { ...filterInput, requested_status: params.status }),
      async () => walk<Row>({ route, filters: filters.upstream }),
    );
    const walked = cached.value;

    const now = today();
    const mapped = walked.rows.map((row) => {
      const due = pickString(row, fields.payment.dueDate);
      const paid = pickString(row, fields.payment.paidDate);
      const reported = pickNumber(row, fields.payment.deviationDays);
      const derived = deviationDays(due, paid);
      const dueDate = toDateOnly(due);
      const paidDate = toDateOnly(paid);
      return {
        contract_id: pickString(row, fields.payment.contractId),
        invoice_number: pickString(row, fields.payment.invoiceNumber),
        invoice_date: toDateOnly(pickString(row, fields.payment.invoiceDate)),
        due_date: dueDate,
        paid_date: paidDate,
        klip_status: pickString(row, fields.payment.status),
        amount: pickNumber(row, fields.payment.amount),
        currency: pickString(row, fields.payment.currency) ?? 'IDR',
        deviation_days: reported ?? derived,
        deviation_source: reported !== null ? ('klip' as const) : derived !== null ? ('derived' as const) : null,
        is_paid: paidDate !== null,
        is_overdue: paidDate === null && dueDate !== null && dueDate < now,
      };
    });

    let rows = mapped;
    if (params.status === 'overdue') rows = rows.filter((r) => r.is_overdue);
    else if (params.status === 'paid') rows = rows.filter((r) => r.is_paid);
    else if (params.status === 'due') rows = rows.filter((r) => !r.is_paid);

    if (filters.local.includes('contract_id')) {
      rows = rows.filter((r) => matchesLoosely(r.contract_id, params.contract_id));
    }

    const byCurrency = new Map<string, { amount: number; rows: number }>();
    let unknownAmounts = 0;
    for (const r of rows) {
      if (r.amount === null) {
        unknownAmounts += 1;
        continue;
      }
      const entry = byCurrency.get(r.currency) ?? { amount: 0, rows: 0 };
      entry.amount += r.amount;
      entry.rows += 1;
      byCurrency.set(r.currency, entry);
    }

    const totalsKey = walked.truncated ? 'totals_partial' : 'totals';
    const data: Record<string, unknown> = {
      [totalsKey]: {
        matching_payments: rows.length,
        overdue_count: rows.filter((r) => r.is_overdue).length,
        paid_count: rows.filter((r) => r.is_paid).length,
        amounts_by_currency: [...byCurrency.entries()].map(([currency, v]) => ({
          currency,
          total_amount: v.amount,
          payments: v.rows,
        })),
        excluded_missing_amount: unknownAmounts,
      },
      payments: rows.slice(0, limit),
      rows_shown: Math.min(rows.length, limit),
      overdue_definition: `Unpaid with a due date before ${now} (Western Indonesia time).`,
      deviation_note:
        'deviation_source says whether deviation_days came from KLIP ("klip") or was computed from due and paid ' +
        'dates ("derived"). Null means it cannot be determined.',
    };

    if (walked.truncated) {
      data.partial_totals_warning =
        `Labelled ${totalsKey}: the fetch hit its page bound (${walked.fetchedRows} rows read), so these counts and ` +
        'amounts are partial. Ask the user to narrow the date range before quoting a total.';
    }
    if (params.status === 'overdue' || params.status === 'due') {
      data.local_status_note =
        'The overdue/due split is computed by the gateway from due and paid dates, since KLIP exposes no ' +
        'server-side "overdue" filter. Verify a critical figure in the KLIP Finance module.';
    }
    const note = localFilterNote(filters.local);
    if (note !== undefined) data.local_filter_note = note;
    if (rows.length === 0) {
      data.empty_result_note = 'No payments matched these filters.';
    }

    return {
      data,
      units: null,
      rowCount: Math.min(rows.length, limit),
      truncated: walked.truncated || rows.length > limit,
      asOf: cached.fetchedAt,
      fromCache: cached.fromCache,
      coverage: {
        fetched_rows: walked.fetchedRows,
        total_rows: walked.totalRows,
        pages_fetched: walked.pagesFetched,
        total_pages: walked.totalPages,
      },
      klipCalls: walked.calls,
    };
  },
};

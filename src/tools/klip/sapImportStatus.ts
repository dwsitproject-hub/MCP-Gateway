/**
 * klip_sap_import_status - "Did today's SAP import succeed?"  (PRD U4)
 *
 * Built first, per the implementation guide: one endpoint, no arithmetic, so it
 * proves the whole pipeline (auth -> guard -> fetch -> envelope -> audit) before
 * any business logic is layered on.
 */
import { z } from 'zod';
import { walk } from './../../adapters/klip/paginate.js';
import { routes } from './../../adapters/klip/routes.js';
import { fields, pickNumber, pickString, type Row } from './../../adapters/klip/fields.js';
import { toWibIso } from './../../adapters/klip/normalize.js';
import * as cache from './../../core/cache.js';
import { describe, type ToolDefinition, type ToolOutcome } from './types.js';

const CAP = 10;

const inputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(CAP)
    .default(5)
    .describe(`How many recent imports to return (max ${CAP}).`),
};

interface ImportRow {
  import_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: string | null;
  rows_processed: number | null;
  rows_failed: number | null;
  file_name: string | null;
  message: string | null;
}

function mapRow(row: Row): ImportRow {
  return {
    import_id: pickString(row, fields.sapImport.id),
    started_at: toWibIso(pickString(row, fields.sapImport.startedAt)),
    finished_at: toWibIso(pickString(row, fields.sapImport.finishedAt)),
    status: pickString(row, fields.sapImport.status),
    rows_processed: pickNumber(row, fields.sapImport.rowsProcessed),
    rows_failed: pickNumber(row, fields.sapImport.rowsFailed),
    file_name: pickString(row, fields.sapImport.fileName),
    message: pickString(row, fields.sapImport.message),
  };
}

export const sapImportStatus: ToolDefinition<typeof inputShape> = {
  name: 'klip_sap_import_status',
  title: 'KLIP SAP import status',
  cap: CAP,
  description: describe(
    'Report the most recent SAP MASTER v2 imports into KLIP: when each ran, whether it succeeded, and how many ' +
      'rows were processed and failed. Use this for questions like "did today\'s SAP import work?". ' +
      'When an import reports failures, direct the user to the KLIP import screen for row-level errors - ' +
      'this tool does not return individual failed rows.',
    `Returns at most ${CAP} imports, newest first.`,
  ),
  inputShape,

  async handler(params): Promise<ToolOutcome> {
    const route = routes.sapImports;
    const limit = Math.min(params.limit, CAP);

    const cached = await cache.through(cache.keyFor('klip_sap_import_status', { limit }), async () => {
      const upstream: Record<string, string | number | undefined> = {};
      const limitParam = route.params.limit;
      if (limitParam !== undefined) upstream[limitParam] = Math.min(limit, route.maxLimit || limit);
      return walk<Row>({ route, filters: upstream, maxPages: 1 });
    });

    const walked = cached.value;
    const imports = walked.rows.slice(0, limit).map(mapRow);

    return {
      data: {
        imports,
        latest: imports[0] ?? null,
        note:
          imports.length === 0
            ? 'KLIP returned no import records. This is an empty result, not a failed import.'
            : undefined,
      },
      units: null,
      rowCount: imports.length,
      truncated: walked.truncated || walked.rows.length > limit,
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

/**
 * Shared plumbing for the dwshub_* tools: application names, provenance wording.
 *
 * People name applications ("KLIP", "the Hub"); the Hub API scopes by id. Names are
 * resolved against the Hub's own list, never guessed, and an unknown name is an error
 * that lists the real ones - the same rule klip_reference enforces for plants.
 */
import { z } from 'zod';
import * as cache from './../../core/cache.js';
import { invalidParams } from './../../core/errors.js';
import { dwshubGet, type DwsHubCallRecord } from './../../adapters/dwshub/client.js';
import { dwshubRoutes } from './../../adapters/dwshub/routes.js';

export const DWSHUB_READ_ONLY_NOTE =
  'READ-ONLY: this tool only reads what the DWS Hub and its Sentinel agent have already recorded. It cannot ' +
  'start a Sentinel analysis, change a bug report, or alter anything in the Hub. People appear as stable ' +
  'pseudonyms (user-...@redacted.invalid); the same pseudonym is the same person across results.';

export function describeHub(text: string, cap: string): string {
  return `${text.trim()} ${cap.trim()} ${DWSHUB_READ_ONLY_NOTE}`;
}

export const applicationParam = z
  .string()
  .min(1)
  .max(120)
  .describe('An application as the Hub names it (e.g. "KLIP"), or "Downstream Hub" for the Hub itself. Omit for all.');

export interface AppRow {
  scope: string;
  name: string;
  target_url: string | null;
  code_connected: boolean;
  auto_analyze: boolean;
  open_reports: number;
  errors_7d: number;
  user_reports_7d: number;
  health_status: string | null;
  health_headline: string | null;
  health_at: string | null;
}

export async function applications(calls: DwsHubCallRecord[]): Promise<{ rows: AppRow[]; asOf: Date; fromCache: boolean }> {
  const cached = await cache.through(cache.keyFor('dwshub_applications', {}), async () =>
    dwshubGet<{ applications: AppRow[] }>(dwshubRoutes.applications.path, {}, calls),
  );
  return { rows: cached.value.applications ?? [], asOf: cached.fetchedAt, fromCache: cached.fromCache };
}

const HUB_NAMES = new Set(['hub', 'dws hub', 'downstream hub', 'the hub', 'dwshub']);

/** Name -> scope ("hub" or an application id). Exact (case-insensitive) first, then a unique partial match. */
export function resolveScope(name: string, rows: AppRow[]): { scope: string; name: string } {
  const wanted = name.trim().toLowerCase();
  if (HUB_NAMES.has(wanted)) return { scope: 'hub', name: 'Downstream Hub' };
  const exact = rows.find((r) => r.name.toLowerCase() === wanted);
  if (exact) return { scope: exact.scope, name: exact.name };
  const partial = rows.filter((r) => r.name.toLowerCase().includes(wanted) || wanted.includes(r.name.toLowerCase()));
  if (partial.length === 1 && partial[0] !== undefined) return { scope: partial[0].scope, name: partial[0].name };
  throw invalidParams(
    partial.length > 1
      ? `"${name}" matches more than one application in the DWS Hub: ${partial.map((r) => r.name).join(', ')}. Use the exact name.`
      : `There is no application called "${name}" in the DWS Hub. Known applications: ${rows.map((r) => r.name).join(', ') || '(none)'}.`,
  );
}

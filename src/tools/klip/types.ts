/**
 * Tool definition contract (TSD Section 5.2 / Section 6).
 *
 * Layering (T-3): tools/ may import adapters/ and core/. Nothing here touches
 * http/ or the MCP transport, so a tool can be exercised in a unit test with no
 * server running.
 *
 * Every tool follows the same pipeline, enforced by the runner rather than by
 * convention: zod validate -> audit(request) -> adapter -> normalize -> cap ->
 * wrap -> audit(outcome).
 */
import type { z } from 'zod';
import type { Coverage } from './../../mcp/envelope.js';
import type { CallRecord } from './../../adapters/klip/session.js';

export interface ToolContext {
  requestId: string;
  userId: string;
  clientIp?: string | undefined;
  oauthClientId?: string | undefined;
}

export interface ToolOutcome {
  /** Tool-specific payload placed under the envelope's `data` key. */
  data: unknown;
  /** Units of any quantity in the payload, or null when there are none. */
  units: string | null;
  rowCount: number;
  truncated: boolean;
  /** When the data was read from KLIP. A cached read keeps its original timestamp. */
  asOf: Date;
  fromCache?: boolean;
  coverage?: Coverage | undefined;
  dataQuality?: Record<string, number> | undefined;
  /** KLIP endpoints actually hit, for the audit record. Paths only, never query strings. */
  klipCalls: CallRecord[];
}

/** A zod raw shape: the SDK converts it to the JSON Schema advertised to Claude. */
export type InputShape = Record<string, z.ZodTypeAny>;

export interface ToolDefinition<Shape extends InputShape = InputShape> {
  name: string;
  title: string;
  /** MUST state that the tool is read-only (PRD Section 8.1). */
  description: string;
  inputShape: Shape;
  /** Row cap advertised in the description and enforced before data enters context. */
  cap: number;
  handler: (params: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** Appended to every tool description so the read-only contract is visible to the model. */
export const READ_ONLY_NOTE =
  'READ-ONLY: this tool only reads KLIP data. It cannot create, update, approve or delete anything, ' +
  'and no such capability exists anywhere in this connector.';

export function describe(text: string, cap: string): string {
  return `${text.trim()} ${cap.trim()} ${READ_ONLY_NOTE}`;
}

/**
 * Knowledge tool registry — the connector's context & memory surface.
 *
 * These three tools are the ONLY writers in the gateway, and what they write is
 * the gateway's own knowledge base (its local Postgres — the database that
 * already stores OAuth clients and audit rows). None of them import the KLIP
 * adapter, so the S1 guarantee stands unchanged: no code path in this service
 * can write to KLIP.
 *
 * Registered separately from klipTools so the "no write tools here" claim in
 * tools/klip/index.ts stays literally true.
 */
import type { ToolDefinition, InputShape } from './../klip/types.js';
import { knowledgeSearch } from './search.js';
import { knowledgeSave } from './save.js';
import { knowledgeFeedback } from './feedback.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous input shapes
export const knowledgeTools: ReadonlyArray<ToolDefinition<any>> = [knowledgeSearch, knowledgeSave, knowledgeFeedback];

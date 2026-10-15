/**
 * The dwshub_* family: DWS Hub production support (Sentinel's results), read-only and
 * admin-only. Empty when the DWS Hub data API is not configured - a tool that cannot
 * reach its upstream is not advertised (same rule as JPS).
 */
import { dwshubConfigured } from './../../adapters/dwshub/client.js';
import { dwshubControlConfigured } from './../../adapters/dwshub/control.js';
import { dwshubSetSentinelModel } from './control.js';
import type { InputShape, ToolDefinition } from './../klip/types.js';
import { dwshubAppHealth, dwshubBugReports, dwshubErrorTrends, dwshubSentinelDetail, dwshubSentinelFindings } from './tools.js';

export const allDwsHubTools: ReadonlyArray<ToolDefinition<InputShape>> = [
  dwshubAppHealth as unknown as ToolDefinition<InputShape>,
  dwshubSentinelFindings as unknown as ToolDefinition<InputShape>,
  dwshubSentinelDetail as unknown as ToolDefinition<InputShape>,
  dwshubBugReports as unknown as ToolDefinition<InputShape>,
  dwshubErrorTrends as unknown as ToolDefinition<InputShape>,
];

export const dwshubTools: ReadonlyArray<ToolDefinition<InputShape>> = dwshubConfigured() ? allDwsHubTools : [];

export const dwshubToolNames: readonly string[] = dwshubTools.map((t) => t.name);

/**
 * The one dwshub_* tool that writes to the Hub (Sentinel's model). Kept out of the read-only
 * family above so its READ-ONLY guarantees stay literal. Empty unless the control key is set.
 */
export const dwshubControlTools: ReadonlyArray<ToolDefinition<InputShape>> = dwshubControlConfigured()
  ? [dwshubSetSentinelModel as unknown as ToolDefinition<InputShape>]
  : [];

/**
 * Jetty Planning System tools.
 *
 * Registered SEPARATELY from klipTools, for the same reason the knowledge tools are:
 * the S1 read-only guarantee is stated per family, and mixing them into one list would
 * blur which promise covers which tool. These are read-only toward JPS and the adapter
 * cannot emit a write - see adapters/jetty/client.ts.
 *
 * The list is EMPTY when JPS is not configured. Advertising a tool that will always
 * fail is worse than not advertising it: a model that can see `jetty_at_berth` will
 * reach for it, and "the gateway has no JPS connection" arrives as a tool error rather
 * than as an honest absence. A deployment that later adds JETTY_* restarts anyway, and
 * clients re-read the tool list on reconnect.
 */
import { jettyConfigured } from './../../adapters/jetty/client.js';
import type { InputShape, ToolDefinition } from './../klip/types.js';
import { jettyAtBerth } from './atBerth.js';
import { jettyTankFarm } from './tankFarm.js';

/** Every jetty tool, whether or not this deployment can reach JPS. */
export const allJettyTools: ReadonlyArray<ToolDefinition<InputShape>> = [
  jettyAtBerth as unknown as ToolDefinition<InputShape>,
  jettyTankFarm as unknown as ToolDefinition<InputShape>,
];

/** What this deployment actually exposes. */
export const jettyTools: ReadonlyArray<ToolDefinition<InputShape>> = jettyConfigured() ? allJettyTools : [];

export const jettyToolNames: readonly string[] = jettyTools.map((t) => t.name);

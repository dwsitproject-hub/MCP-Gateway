/**
 * dwshub_set_sentinel_model - the one dwshub_* tool that WRITES to the DWS Hub.
 *
 * It changes a single setting: which Claude model the Hub's Sentinel uses for its bug
 * analyses, health reports and answers. Milo calls it from code when the Boss changes
 * Sentinel's model on Milo's Agent team page, so both run the same model. It is NOT on any
 * Milo agent's tool allowlist, and its description tells other clients not to call it on
 * their own initiative.
 *
 * Admin-only (gateway admins), and the Hub separately requires its control key, accepts
 * only its own list of models, and writes every change to its audit log.
 */
import { z } from 'zod';
import { setSentinelModel } from './../../adapters/dwshub/control.js';
import type { DwsHubCallRecord } from './../../adapters/dwshub/client.js';
import type { ToolDefinition, ToolOutcome } from './../klip/types.js';

const shape = {
  model: z
    .string()
    .regex(/^claude-[a-z0-9-]{3,60}$/, 'A Claude model id, e.g. "claude-opus-5-5".')
    .describe('The Claude model id for the Hub\'s Sentinel, e.g. "claude-opus-5-5". The Hub accepts only its own list and names it if this one is not on it.'),
};

export const dwshubSetSentinelModel: ToolDefinition<typeof shape> = {
  name: 'dwshub_set_sentinel_model',
  title: 'Set the DWS Hub Sentinel model',
  cap: 1,
  adminOnly: true,
  readOnly: false,
  description:
    'WRITES ONE SETTING in the DWS Hub: which Claude model the Hub\'s Sentinel agent uses for its bug analyses, ' +
    'health reports and answers. Used by Milo to keep the Hub in step when the Boss changes Sentinel\'s model. ' +
    'Call it ONLY when a person has explicitly asked to change Sentinel\'s model - never on your own initiative, ' +
    'never to work around a failed analysis. It changes nothing else: it cannot start or cancel a Sentinel run, ' +
    'change a bug report, or alter application data. Setting the model it already uses is a no-op.',
  inputShape: shape,
  async handler(params, ctx) {
    const calls: DwsHubCallRecord[] = [];
    const res = await setSentinelModel(params.model, ctx.userId, calls);
    const outcome: ToolOutcome = {
      data: {
        model: res.model,
        previous: res.previous,
        changed: res.changed,
        set_by: res.source,
        updated_at: res.updated_at,
        note: res.changed
          ? `The Hub's Sentinel now uses ${res.model} (was ${res.previous}). Runs already in progress finish on the old model.`
          : `The Hub's Sentinel already uses ${res.model}; nothing changed.`,
      },
      units: null,
      rowCount: 1,
      truncated: false,
      asOf: new Date(res.updated_at ?? Date.now()),
      klipCalls: calls,
      system: 'dwshub',
    };
    return outcome;
  },
};

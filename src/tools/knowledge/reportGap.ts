/**
 * klip_report_gap - the connector recording that it could not answer.
 *
 * The one thing the gateway genuinely cannot detect on its own. When no tool covers a
 * question, nothing is called and nothing fails: a model simply tells the user it
 * cannot help, and the gateway never hears about it. Every gap found this month was
 * found by a person reading a weak answer and going to check the screen - and in four
 * of five cases the data was already reachable and the connector was not wired to it.
 *
 * So the model reports it, and the ranked list appears on /admin rather than in
 * someone's memory.
 *
 * WRITES GATEWAY-LOCAL ONLY. Nothing here touches KLIP or JPS.
 */
import { z } from 'zod';
import * as gaps from './../../core/gaps.js';
import type { ToolDefinition, ToolOutcome, ToolContext } from './../klip/types.js';

const inputShape = {
  topic: z
    .string()
    .min(3)
    .max(120)
    .describe('The missing capability in a few words, e.g. "tank farm stock by product". Used to GROUP gaps, so keep it about the subject rather than the phrasing.'),
  question: z
    .string()
    .max(500)
    .optional()
    .describe('The question as the user actually asked it. Stored so the gap is actionable; cleared when the gap is resolved and after 90 days.'),
  system: z
    .enum(['klip', 'jetty', 'gateway', 'unknown'])
    .default('unknown')
    .describe('Which upstream the answer would have come from, if it can be told.'),
};

export const reportGap: ToolDefinition<typeof inputShape> = {
  name: 'klip_report_gap',
  title: 'Record that the connector could not answer',
  description:
    'Record a question this connector could not answer, so the gateway team can see what is most often ' +
    'missing. CALL THIS whenever you have to tell someone the connector cannot reach something - no tool ' +
    'covers it, a tool returned capability-unavailable, or the data is visible in KLIP or JPS but no tool ' +
    'surfaces it. ' +
    'Call it IN ADDITION to telling the user plainly that you cannot answer and pointing them at the ' +
    'source application, never instead of that. ' +
    'DO NOT call it when a tool answered and the result was simply empty - no vessels alongside, no ' +
    'contracts matching a filter, no tanks holding a product are real answers, not gaps. Do not call it ' +
    'more than once for the same question in one conversation. ' +
    'WRITES GATEWAY-LOCAL ONLY: this records a note in the gateway\'s own gap log. It never writes to ' +
    'KLIP or JPS, and it does not make the missing data appear - the tool still does not exist.',
  inputShape,
  cap: 1,
  readOnly: false,
  handler: async (params, ctx: ToolContext): Promise<ToolOutcome> => {
    await gaps.record({
      topic: params.topic,
      question: params.question,
      system: params.system,
      reason: 'reported',
      userId: ctx.userId,
    });

    return {
      data: {
        recorded: true,
        grouped_as: gaps.slugify(params.topic),
        // Said back explicitly, because a model that reads "recorded" as "handled" would
        // go on to answer the question anyway.
        note:
          'Logged for the gateway team. This does NOT make the data available - tell the user you cannot ' +
          'answer, and point them at the KLIP or JPS application for it.',
        privacy_note:
          'The question text is stored so the gap can be acted on. It is cleared when the gap is resolved ' +
          'and after 90 days regardless.',
      },
      units: null,
      rowCount: 1,
      truncated: false,
      asOf: new Date(),
      klipCalls: [],
    };
  },
};

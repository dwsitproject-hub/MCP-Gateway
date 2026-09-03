/**
 * klip_knowledge_feedback — the curation signal that makes the memory self-improving.
 *
 * Promotion and deprecation are driven by DISTINCT users' votes, not by volume
 * from one session: two helpful votes verify a proposed entry, two outdated
 * votes retire it (and a verified correction retires the entry it supersedes).
 */
import { z } from 'zod';
import * as knowledge from './../../core/knowledge.js';
import type { ToolDefinition, ToolOutcome, ToolContext } from './../klip/types.js';

const inputShape = {
  slug: z.string().min(1).max(80).describe('Slug of the knowledge entry, as returned by klip_knowledge_search.'),
  vote: z
    .enum(['helpful', 'outdated'])
    .describe('helpful = the entry correctly answered the user; outdated = the user or KLIP data contradicted it.'),
  note: z
    .string()
    .max(knowledge.LIMITS.note)
    .optional()
    .describe('For outdated votes: what was wrong, in one sentence.'),
};

export const knowledgeFeedback: ToolDefinition<typeof inputShape> = {
  name: 'klip_knowledge_feedback',
  title: 'Vote on a knowledge entry',
  description:
    'Record whether a knowledge entry actually helped answer the user, or is outdated/wrong. Vote helpful when an ' +
    'entry resolved the user\'s question; vote outdated when the user or fresh KLIP data contradicted it (then save ' +
    'the corrected fact with klip_knowledge_save, passing supersedes). One vote per user per entry - a repeat vote ' +
    'replaces the previous one. Two distinct helpful votes verify an entry; two outdated votes deprecate it. ' +
    'WRITES GATEWAY-LOCAL ONLY: this updates the gateway\'s own knowledge base, never KLIP.',
  inputShape,
  cap: 1,
  readOnly: false,
  handler: async (params, ctx: ToolContext): Promise<ToolOutcome> => {
    const result = await knowledge.feedback(params.slug, params.vote, params.note, ctx.userId);
    return {
      data: {
        entry: {
          slug: result.entry.slug,
          title: result.entry.title,
          status: result.entry.status,
          helpful_count: result.entry.helpful_count,
          outdated_count: result.entry.outdated_count,
        },
        transition: result.transition,
        note:
          result.transition === 'promoted'
            ? 'The entry is now verified and will be served to all future conversations.'
            : result.transition === 'deprecated'
              ? 'The entry is now deprecated and hidden from normal search. If a corrected fact exists, save it with klip_knowledge_save.'
              : 'Vote recorded.',
      },
      units: null,
      rowCount: 1,
      truncated: false,
      asOf: new Date(),
      klipCalls: [],
    };
  },
};

/**
 * klip_knowledge_save — write a durable fact into the gateway's own knowledge base.
 *
 * This is how the connector learns: a definition the user explained, a data
 * caveat discovered the hard way, a business rule confirmed by the KLIP team.
 * The entry lands as `proposed` and stays clearly labelled as such until two
 * distinct users mark it helpful. It is stored in the GATEWAY's Postgres and
 * never touches KLIP - the KLIP adapter has no write path.
 */
import { z } from 'zod';
import * as knowledge from './../../core/knowledge.js';
import type { ToolDefinition, ToolOutcome, ToolContext } from './../klip/types.js';

const inputShape = {
  kind: z
    .enum(knowledge.KINDS)
    .describe(
      'definition = what a term means; business_rule = how the business works; data_caveat = a trap in the data; ' +
        'qa = a question with its confirmed answer; preference = how users want answers presented.',
    ),
  topic: z
    .string()
    .min(1)
    .max(knowledge.LIMITS.topic)
    .describe('One word where it belongs: contracts, shipments, outstanding, oil-loss, trucking, sap, general...'),
  title: z.string().min(5).max(knowledge.LIMITS.title).describe('One line stating the fact, e.g. "Contract quantities are stored in KG".'),
  body: z
    .string()
    .min(20)
    .max(knowledge.LIMITS.body)
    .describe(
      'The fact itself, self-contained: what is true, how it was established (who confirmed it / which data showed it), ' +
        'and an as-of date. Write it for a future AI that has NO access to this conversation.',
    ),
  tags: z.array(z.string().max(knowledge.LIMITS.tag)).max(knowledge.LIMITS.tags).optional().describe('Search keywords.'),
  supersedes: z
    .string()
    .optional()
    .describe('Slug of the entry this corrects. The old entry is deprecated once this one is verified.'),
};

export const knowledgeSave: ToolDefinition<typeof inputShape> = {
  name: 'klip_knowledge_save',
  title: 'Save a fact to the gateway knowledge base',
  description:
    'Save a DURABLE fact about KLIP or the business into the connector\'s shared knowledge base, so future ' +
    'conversations - any user, any AI client - start from it. Save facts that will still be true next month: ' +
    'definitions, business rules, data caveats, confirmed Q&A. Do NOT save conversation-specific numbers, ' +
    'personal data, or anything the user has not established as true. Before saving, search first: if a matching ' +
    'entry exists, prefer klip_knowledge_feedback (or supersede it) over creating a near-duplicate. ' +
    'New entries are marked "proposed" until two distinct users confirm them. ' +
    'WRITES GATEWAY-LOCAL ONLY: this stores a note in the gateway\'s own database. It cannot write to KLIP - ' +
    'no tool in this connector can create, update, approve or delete anything in KLIP.',
  inputShape,
  cap: 1,
  readOnly: false,
  handler: async (params, ctx: ToolContext): Promise<ToolOutcome> => {
    const result = await knowledge.save(
      {
        kind: params.kind,
        topic: params.topic,
        title: params.title,
        body: params.body,
        tags: params.tags,
        supersedes: params.supersedes,
      },
      ctx.userId,
      ctx.oauthClientId,
    );
    const duplicate = result.duplicateOf !== undefined;
    return {
      data: {
        saved: !duplicate,
        duplicate_of: result.duplicateOf ?? null,
        entry: {
          slug: result.entry.slug,
          kind: result.entry.kind,
          topic: result.entry.topic,
          title: result.entry.title,
          status: result.entry.status,
        },
        note: duplicate
          ? 'An entry with this content already exists; nothing new was created. Vote on it with klip_knowledge_feedback instead.'
          : 'Saved as "proposed". It becomes "verified" after two distinct users mark it helpful. Tell the user what was saved.',
      },
      units: null,
      rowCount: 1,
      truncated: false,
      asOf: new Date(),
      klipCalls: [],
    };
  },
};

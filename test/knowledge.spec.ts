/**
 * The gateway knowledge base is the connector's memory across conversations and
 * AI providers. Two properties carry the design and are what these tests pin:
 *
 *  1. TRUST LIFECYCLE - an AI-saved entry is `proposed` (a claim), and becomes
 *     `verified` (served as fact, eligible for the instructions preamble) only
 *     through two DISTINCT users' helpful votes. Two outdated votes retire it.
 *     Repetition by one user must never promote anything.
 *
 *  2. WRITE BOUNDARY - the knowledge tools write to the gateway's own store
 *     only. Every KLIP tool stays read-only, and the knowledge tools declare
 *     readOnly: false so the MCP annotations stay honest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCall {
  sql: string;
  params: readonly unknown[];
}

const calls: FakeCall[] = [];
let responder: (sql: string, params: readonly unknown[]) => unknown[] = () => [];

vi.mock('../src/core/db.js', () => ({
  query: async (sql: string, params: readonly unknown[] = []): Promise<unknown[]> => {
    calls.push({ sql, params });
    return responder(sql, params);
  },
  queryOne: async (sql: string, params: readonly unknown[] = []): Promise<unknown> => {
    calls.push({ sql, params });
    return responder(sql, params)[0];
  },
}));

import * as knowledge from '../src/core/knowledge.js';
import { knowledgeTools } from '../src/tools/knowledge/index.js';
import { klipTools } from '../src/tools/klip/index.js';
import { GatewayError } from '../src/core/errors.js';

function entryRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    slug: 'test-entry',
    kind: 'data_caveat',
    topic: 'contracts',
    title: 'Test entry',
    body: 'A body long enough to be a real fact about KLIP data.',
    tags: ['test'],
    status: 'proposed',
    pinned: false,
    source: 'ai',
    created_by: 'a@example.com',
    helpful_count: 0,
    outdated_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
  knowledge.clearInstructionsCache();
});

describe('text hygiene', () => {
  it('strips control characters, collapses whitespace and caps length', () => {
    expect(knowledge.cleanText('a\u0000b\u001Fc   d\n\ne', 100)).toBe('a b c d e');
    expect(knowledge.cleanText('x'.repeat(50), 10)).toHaveLength(10);
  });

  it('derives a usable slug even from awkward titles', () => {
    expect(knowledge.slugify('What "Group Plant" means!')).toBe('what-group-plant-means');
    expect(knowledge.slugify('***')).toBe('entry');
  });
});

describe('save', () => {
  it('rejects empty fields before touching the database', async () => {
    await expect(
      knowledge.save({ kind: 'qa', topic: ' ', title: 'ok title here', body: 'a body of reasonable length' }, 'u', undefined),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(calls).toHaveLength(0);
  });

  it('enforces the per-user daily cap', async () => {
    responder = (sql) => (sql.includes('COUNT(*) AS n') ? [{ n: String(knowledge.LIMITS.dailySavesPerUser) }] : []);
    await expect(
      knowledge.save(
        { kind: 'qa', topic: 'general', title: 'a valid title', body: 'a body of reasonable length here' },
        'flooder@example.com',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('returns the existing entry instead of inserting a duplicate body', async () => {
    responder = (sql) => {
      if (sql.includes('COUNT(*) AS n')) return [{ n: '0' }];
      if (sql.includes('regexp_replace')) return [entryRow({ slug: 'existing-entry' })];
      return [];
    };
    const out = await knowledge.save(
      { kind: 'qa', topic: 'general', title: 'another title', body: 'A body long enough to be a real fact about KLIP data.' },
      'u@example.com',
      undefined,
    );
    expect(out.duplicateOf).toBe('existing-entry');
    expect(calls.some((c) => c.sql.includes('INSERT INTO knowledge_entries'))).toBe(false);
  });

  it('inserts as proposed with a slug derived from the title', async () => {
    responder = (sql) => {
      if (sql.includes('COUNT(*) AS n')) return [{ n: '0' }];
      if (sql.includes('regexp_replace')) return [];
      if (sql.includes('WHERE slug = $1') && !sql.includes('INSERT')) return [];
      if (sql.includes('INSERT INTO knowledge_entries')) return [entryRow({ slug: 'contract-qty-is-kg', status: 'proposed' })];
      return [];
    };
    const out = await knowledge.save(
      { kind: 'data_caveat', topic: 'Contracts', title: 'Contract qty is KG', body: 'Quantities are stored in KG; divide by 1000 for MT.' },
      'u@example.com',
      'client-1',
    );
    expect(out.entry.status).toBe('proposed');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO knowledge_entries'));
    expect(insert?.params[0]).toBe('contract-qty-is-kg');
    // topic normalised to lowercase
    expect(insert?.params[2]).toBe('contracts');
    expect(insert?.params[6]).toBe('u@example.com');
  });
});

describe('feedback lifecycle', () => {
  function feedbackResponder(counts: { helpful: number; outdated: number }, status = 'proposed') {
    return (sql: string) => {
      if (sql.includes('FROM knowledge_entries WHERE slug')) return [entryRow({ status })];
      if (sql.includes('FROM knowledge_feedback')) return [{ helpful: String(counts.helpful), outdated: String(counts.outdated) }];
      if (sql.startsWith('UPDATE knowledge_entries') && sql.includes('RETURNING')) {
        const promoted = status === 'proposed' && counts.helpful >= knowledge.LIMITS.promoteVotes;
        const deprecated = counts.outdated >= knowledge.LIMITS.deprecateVotes;
        return [entryRow({ status: deprecated ? 'deprecated' : promoted ? 'verified' : status })];
      }
      return [];
    };
  }

  it('one helpful vote does not promote', async () => {
    responder = feedbackResponder({ helpful: 1, outdated: 0 });
    const out = await knowledge.feedback('test-entry', 'helpful', undefined, 'a@example.com');
    expect(out.transition).toBe('none');
  });

  it('two distinct helpful votes promote proposed to verified and retire the superseded entry', async () => {
    responder = feedbackResponder({ helpful: 2, outdated: 0 });
    const out = await knowledge.feedback('test-entry', 'helpful', undefined, 'b@example.com');
    expect(out.transition).toBe('promoted');
    expect(out.entry.status).toBe('verified');
    expect(calls.some((c) => c.sql.includes("SET status = 'deprecated'") && c.sql.includes('supersedes_id'))).toBe(true);
  });

  it('two outdated votes deprecate even a verified entry', async () => {
    responder = feedbackResponder({ helpful: 0, outdated: 2 }, 'verified');
    const out = await knowledge.feedback('test-entry', 'outdated', 'plant list changed', 'c@example.com');
    expect(out.transition).toBe('deprecated');
    expect(out.entry.status).toBe('deprecated');
  });

  it('votes are keyed one-per-user so repetition cannot promote', async () => {
    responder = feedbackResponder({ helpful: 1, outdated: 0 });
    await knowledge.feedback('test-entry', 'helpful', undefined, 'same@example.com');
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO knowledge_feedback'));
    expect(upsert?.sql).toContain('ON CONFLICT (entry_id, user_id) DO UPDATE');
  });

  it('unknown slug is NOT_FOUND', async () => {
    responder = () => [];
    await expect(knowledge.feedback('nope', 'helpful', undefined, 'u')).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('search', () => {
  it('rejects an empty query', async () => {
    await expect(knowledge.search('   ')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('returns full-text hits and bumps usage counters best-effort', async () => {
    responder = (sql) => {
      if (sql.includes('websearch_to_tsquery')) return [entryRow({ status: 'verified' })];
      return [];
    };
    const { hits, match } = await knowledge.search('group plant');
    expect(hits).toHaveLength(1);
    expect(match).toBe('exact');
    // fire-and-forget usage bump was issued
    expect(calls.some((c) => c.sql.includes('use_count = use_count + 1'))).toBe(true);
  });

  it('broadens to an OR of the terms before giving up on meaning', async () => {
    /**
     * websearch_to_tsquery ANDs bare words, so a three-word question found nothing
     * unless one entry carried every term - true of the KLIP entries all along, and it
     * would have made the eleven new jetty entries largely unreachable. The only
     * fallback was an ILIKE on the whole phrase, which needs it verbatim.
     */
    responder = (sql) => {
      if (sql.includes('websearch_to_tsquery')) return [];
      if (sql.includes('to_tsquery')) return [entryRow({ status: 'verified' })];
      return [];
    };
    const { hits, match } = await knowledge.search('vessel berthing occupancy');
    expect(hits).toHaveLength(1);
    expect(match).toBe('broadened');
    const or = calls.find((c) => c.sql.includes('to_tsquery') && !c.sql.includes('websearch_to_tsquery'));
    expect(String(or?.params[0])).toBe('vessel | berthing | occupancy');
  });

  it('keeps punctuation out of the broadened query, which to_tsquery would parse', async () => {
    // to_tsquery reads &, |, ! and ( ) as operators, so an unescaped question mark or
    // ampersand from a user would be a syntax error rather than a search.
    responder = (sql) => {
      if (sql.includes('websearch_to_tsquery')) return [];
      if (sql.includes('to_tsquery')) return [entryRow()];
      return [];
    };
    await knowledge.search("what's ETC & NOR? (laytime)");
    const or = calls.find((c) => c.sql.includes('to_tsquery') && !c.sql.includes('websearch_to_tsquery'));
    expect(String(or?.params[0])).toBe('what | ETC | NOR | laytime');
  });

  it('falls back to substring match when full-text yields nothing', async () => {
    responder = (sql) => {
      if (sql.includes('websearch_to_tsquery')) return [];
      if (sql.includes('ILIKE')) return [entryRow()];
      return [];
    };
    const { hits, match } = await knowledge.search('grp plnt');
    expect(hits).toHaveLength(1);
    expect(match).toBe('substring');
  });

  it('excludes deprecated entries unless asked', async () => {
    let statuses: unknown;
    responder = (sql, params) => {
      if (sql.includes('websearch_to_tsquery')) {
        statuses = params[1];
        return [entryRow()];
      }
      return [];
    };
    await knowledge.search('anything');
    expect(statuses).toEqual(['verified', 'proposed']);
    await knowledge.search('anything', { includeDeprecated: true });
    expect(statuses).toEqual(['verified', 'proposed', 'deprecated']);
  });
});

describe('instructions block', () => {
  it('serves pinned verified knowledge and caches it', async () => {
    responder = (sql) => (sql.includes('pinned') ? [{ title: 'Units', body: 'Quantities are stored in KG.' }] : []);
    const text = await knowledge.instructionsBlock();
    expect(text).toContain('Curated KLIP knowledge');
    expect(text).toContain('Units: Quantities are stored in KG.');
    const callsBefore = calls.length;
    await knowledge.instructionsBlock();
    expect(calls.length).toBe(callsBefore); // cached, no second query
  });

  it('degrades to an empty block when the database fails', async () => {
    responder = () => {
      throw new Error('db down');
    };
    await expect(knowledge.instructionsBlock()).resolves.toBe('');
  });
});

describe('tool surface', () => {
  it('knowledge write tools declare readOnly: false; search stays read-only', () => {
    /**
     * The list is exhaustive on purpose. Every tool that can write anything is named
     * here, so adding one is a deliberate edit to this test rather than a line that
     * slips in unnoticed - which is the only way the write boundary stays a boundary.
     *
     * klip_report_gap joined it on 22 Sep 2026. Like the other two it writes to the
     * gateway's OWN store and never to KLIP or JPS.
     */
    const byName = new Map(knowledgeTools.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual([
      'klip_knowledge_feedback',
      'klip_knowledge_save',
      'klip_knowledge_search',
      'klip_report_gap',
    ]);
    expect(byName.get('klip_knowledge_save')?.readOnly).toBe(false);
    expect(byName.get('klip_knowledge_feedback')?.readOnly).toBe(false);
    expect(byName.get('klip_report_gap')?.readOnly).toBe(false);
    expect(byName.get('klip_knowledge_search')?.readOnly).toBeUndefined();
  });

  it('every KLIP data tool remains read-only', () => {
    for (const tool of klipTools) expect(tool.readOnly).not.toBe(false);
  });
});

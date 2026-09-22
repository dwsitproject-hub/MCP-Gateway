/**
 * The capability gap log.
 *
 * It stores question text, which was a deliberate decision rather than a default, so
 * the tests are mostly about the promises that decision came with:
 *
 *   - resolving a gap KEEPS the count and DELETES the questions
 *   - question text past the retention window is cleared, count kept
 *   - a failure to log never becomes a failure the user sees
 *
 * Plus the grouping, because a log where twelve phrasings of one question rank as
 * twelve singletons never surfaces the gap that matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  sql: string;
  params: readonly unknown[];
}
const calls: Call[] = [];
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

const gaps = await import('../src/core/gaps.js');

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe('grouping questions into gaps', () => {
  it.each([
    ['How much CPO is in the tank farm?', 'cpo-tank-farm'],
    ['what is the CPO in our tank farm', 'cpo-tank-farm'],
    ['Show me the tank farm CPO data', 'tank-farm-cpo'],
  ])('%j -> %j', (topic, slug) => {
    // Filler words are dropped so phrasing stops splitting one gap into several. Word
    // ORDER still matters, which is why the third differs - crude on purpose, because
    // an over-clever normaliser merges gaps that are genuinely different and one gap
    // hiding another is worse than two similar rows.
    expect(gaps.slugify(topic)).toBe(slug);
  });

  it('never produces an empty slug', () => {
    expect(gaps.slugify('how much of the')).toBe('unclassified');
    expect(gaps.slugify('???')).toBe('unclassified');
  });

  it('bounds the slug so one rambling question cannot become its own category', () => {
    const slug = gaps.slugify('berthing milestones anchorage waiting demurrage laytime notice tender acceptance');
    expect(slug.split('-')).toHaveLength(5);
    expect(slug.length).toBeLessThanOrEqual(80);
  });
});

describe('recording', () => {
  it('writes the question alongside the grouping slug', async () => {
    await gaps.record({
      topic: 'tank farm stock',
      question: 'How much CPO do we have at Bontang?',
      system: 'jetty',
      reason: 'reported',
      userId: 'someone@example.com',
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO capability_gaps'));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain('tank-farm-stock');
    expect(insert?.params).toContain('How much CPO do we have at Bontang?');
    expect(insert?.params).toContain('jetty');
  });

  it('records a gap with NO question, for the automatic cases', async () => {
    // An empty knowledge search has no user question attached to it beyond the query
    // itself, and a tool throwing capability-unavailable has none at all.
    await gaps.record({ topic: 'slot occupancy', reason: 'unavailable' });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO capability_gaps'));
    expect(insert?.params).toContain(null);
  });

  it('SWALLOWS a database failure rather than turning it into a tool error', async () => {
    /**
     * The important one. A gap is a note about a failure that already happened; if
     * recording it also fails, the user must still get their answer. Making the log a
     * second point of failure would mean the connector breaks hardest exactly when it
     * is already being unhelpful.
     */
    responder = () => {
      throw new Error('db down');
    };
    await expect(gaps.record({ topic: 'anything', reason: 'reported' })).resolves.toBeUndefined();
  });
});

describe('the retention promise, as implemented', () => {
  it('resolving KEEPS the count and DELETES the questions', async () => {
    responder = () => [{ id: '1' }, { id: '2' }];
    const closed = await gaps.resolve('tank-farm-stock', 'boss@example.com', 'shipped jetty_tank_farm');
    expect(closed).toBe(2);

    const update = calls.find((c) => c.sql.includes('UPDATE capability_gaps'));
    // The row survives - it is the evidence the tool was worth building - and only the
    // wording goes.
    expect(update?.sql).toContain('question = NULL');
    expect(update?.sql).toContain('resolved_at = now()');
    expect(update?.sql).not.toContain('DELETE');
  });

  it('only touches gaps that are still open', async () => {
    responder = () => [];
    await gaps.resolve('already-done', 'boss@example.com', 'note');
    const update = calls.find((c) => c.sql.includes('UPDATE capability_gaps'));
    // Re-resolving must not rewrite who closed it or when.
    expect(update?.sql).toContain('resolved_at IS NULL');
  });

  it('clears question text past the retention window, keeping the row', async () => {
    responder = () => [{ id: '1' }];
    const cleared = await gaps.forgetOldQuestions(90);
    expect(cleared).toBe(1);
    const update = calls.find((c) => c.sql.includes("|| ' days'"));
    expect(update?.sql).toContain('question = NULL');
    expect(update?.sql).toContain('question IS NOT NULL');
    expect(update?.params).toContain('90');
    // The gap itself stays counted. Retention is about the wording, not the fact.
    expect(update?.sql).not.toContain('DELETE');
  });
});

describe('ranking', () => {
  it('orders by how often a gap was hit, then by recency', async () => {
    responder = () => [];
    await gaps.topGaps();
    const select = calls.find((c) => c.sql.includes('FROM capability_gaps'));
    expect(select?.sql).toContain('ORDER BY count(*) DESC');
    expect(select?.sql).toContain('resolved_at IS NULL');
    // At most three questions per gap: enough to see what people meant, not a transcript.
    expect(select?.sql).toContain('[1:3]');
  });
});

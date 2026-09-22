/**
 * The capability gap log: what the connector was asked for and could not answer.
 *
 * Writes here are BEST EFFORT and never propagate. A gap is a note about a failure
 * that already happened - if recording it also fails, the user must still get their
 * answer, and turning a logging problem into a tool error would make the connector
 * less useful at exactly the moment it is already being unhelpful.
 */
import { randomUUID } from 'node:crypto';
import { query, queryOne } from './db.js';
import { logger } from './logger.js';

export type GapReason = 'reported' | 'unavailable' | 'no_knowledge';
export type GapSystem = 'klip' | 'jetty' | 'gateway' | 'unknown';

export interface GapInput {
  /** Free-text topic; normalised into the grouping slug. */
  topic: string;
  question?: string | undefined;
  system?: GapSystem | undefined;
  reason: GapReason;
  tool?: string | undefined;
  userId?: string | undefined;
}

/**
 * Collapse a topic to a grouping key.
 *
 * Twelve phrasings of "how much CPO is in the tank farm" must rank as one gap, not
 * twelve singletons that never reach the top of a list sorted by count. Deliberately
 * crude - lowercase, drop filler, keep the first few distinctive words - because an
 * over-clever normaliser merges gaps that are genuinely different, and two similar
 * entries in the panel cost far less than one that hides another.
 */
const FILLER = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'for', 'to', 'is', 'are', 'was', 'were', 'and', 'or',
  'how', 'what', 'which', 'when', 'where', 'much', 'many', 'do', 'does', 'did', 'we', 'i', 'me',
  'my', 'our', 'can', 'you', 'get', 'show', 'give', 'about', 'from', 'by', 'with', 'data',
]);

export function slugify(topic: string): string {
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
  return (words.length > 0 ? words : ['unclassified']).slice(0, 5).join('-').slice(0, 80);
}

export async function record(input: GapInput): Promise<void> {
  try {
    await query(
      `INSERT INTO capability_gaps (id, slug, question, system, reason, tool, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        slugify(input.topic),
        input.question ?? null,
        input.system ?? 'unknown',
        input.reason,
        input.tool ?? null,
        input.userId ?? null,
      ],
    );
  } catch (err) {
    // Deliberately swallowed. See the header: a failure to log a failure must not
    // become a second failure the user sees.
    logger.warn({ err: (err as Error).message, topic: input.topic }, 'could not record a capability gap');
  }
}

export interface RankedGap {
  slug: string;
  times_asked: number;
  first_seen: Date;
  last_seen: Date;
  systems: string[];
  reasons: string[];
  /** Up to three of the actual questions, newest first. Empty once resolved. */
  questions: string[];
}

/** Open gaps, most asked first, then most recent. */
export async function topGaps(limit = 25): Promise<RankedGap[]> {
  return query<RankedGap>(
    `SELECT slug,
            count(*)::int                                   AS times_asked,
            min(created_at)                                 AS first_seen,
            max(created_at)                                 AS last_seen,
            array_agg(DISTINCT system)                      AS systems,
            array_agg(DISTINCT reason)                      AS reasons,
            (array_remove(array_agg(question ORDER BY created_at DESC), NULL))[1:3] AS questions
       FROM capability_gaps
      WHERE resolved_at IS NULL
      GROUP BY slug
      ORDER BY count(*) DESC, max(created_at) DESC
      LIMIT $1`,
    [limit],
  );
}

export async function countOpen(): Promise<number> {
  const row = await queryOne<{ n: string }>(
    'SELECT count(DISTINCT slug)::text AS n FROM capability_gaps WHERE resolved_at IS NULL',
  );
  return Number(row?.n ?? 0);
}

/**
 * Close a gap: keep the count, drop the questions.
 *
 * The count is the record of what was missing and stays useful afterwards - it is the
 * evidence that a tool was worth building. The question text was only ever there to
 * make the gap actionable, and once it is resolved that job is done, so it goes. This
 * is the retention promise the admin panel makes, implemented rather than described.
 */
export async function resolve(slug: string, by: string, note: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE capability_gaps
        SET resolved_at = now(), resolved_by = $2, resolved_note = $3, question = NULL
      WHERE slug = $1 AND resolved_at IS NULL
      RETURNING id`,
    [slug, by, note],
  );
  return rows.length;
}

/**
 * Clear question text older than the retention window, keeping the counts.
 *
 * A gap nobody has raised in three months does not need its wording kept, and this is
 * the half of the privacy promise that has to run on its own rather than wait for
 * someone to tidy up.
 */
export async function forgetOldQuestions(days = 90): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE capability_gaps
        SET question = NULL
      WHERE question IS NOT NULL AND created_at < now() - ($1 || ' days')::INTERVAL
      RETURNING id`,
    [String(days)],
  );
  if (rows.length > 0) logger.info({ cleared: rows.length }, 'cleared gap question text past retention');
  return rows.length;
}

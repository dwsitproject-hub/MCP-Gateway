-- 011_capability_gaps.sql
--
-- What the connector was asked for and could not answer.
--
-- Five gaps were found this month, every one of them by Jerry noticing an answer that
-- said "the API does not expose that" and checking the screen himself: contract unit
-- price, tank farm stock, the eight berthing milestones, whole-population pricing, and
-- jetty history before today. In four of the five the data was already reachable and
-- the connector simply was not wired to it.
--
-- That discovery loop runs at the speed of one person's attention. This table moves it
-- to the speed of usage: the connector records the moment it comes up short, and the
-- ranked list appears on /admin instead of in someone's memory.
--
-- IT STORES QUESTION TEXT. That is a deliberate choice, made explicitly, because a gap
-- without the question is a count with no actionable content - "someone wanted
-- something about tanks" cannot be built from. Three things follow from it and are
-- implemented rather than promised:
--
--   1. The /admin panel says plainly that question text is stored, so nobody discovers
--      it by accident.
--   2. Resolving a gap keeps the count and DROPS the questions, so the record of what
--      was missing outlives the record of who asked.
--   3. Text older than 90 days is cleared by the same sweep, count retained. A gap
--      nobody has raised in three months does not need its wording kept.
--
-- What this is NOT: a way for the gateway to fix itself. It surfaces what to build. A
-- person still decides whether the data means what the asker thought, which is the part
-- that has been wrong every time.

BEGIN;

CREATE TABLE IF NOT EXISTS capability_gaps (
  id           TEXT PRIMARY KEY,
  -- Normalised topic, so twelve phrasings of "how much CPO is in the tank farm" rank
  -- as one gap rather than twelve singletons that never reach the top of the list.
  slug         TEXT        NOT NULL,
  -- Free text. Nullable: a gap recorded automatically has no question attached.
  question     TEXT,
  -- Which upstream the asker was reaching for, where it can be told.
  system       TEXT        NOT NULL DEFAULT 'unknown'
                 CHECK (system IN ('klip', 'jetty', 'gateway', 'unknown')),
  -- How it was noticed. reported = a model called klip_report_gap on being unable to
  -- answer; unavailable = a tool threw capability-unavailable; no_knowledge = a
  -- knowledge search came back empty.
  reason       TEXT        NOT NULL
                 CHECK (reason IN ('reported', 'unavailable', 'no_knowledge')),
  tool         TEXT,
  user_id      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  resolved_note TEXT
);

-- The admin panel asks one question - what is most asked for and still open - so that
-- is the index. Partial, because resolved rows are read rarely and in bulk.
CREATE INDEX IF NOT EXISTS capability_gaps_open_idx
  ON capability_gaps (slug, created_at DESC) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS capability_gaps_created_idx ON capability_gaps (created_at DESC);

-- Tell a model to use it. Not pinned: the preamble budget is 124 characters and this
-- entry is long, so it lives in search where a model looking for "what do I do when I
-- cannot answer" will find it.
INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES
  ('report-a-capability-gap', 'preference', 'general',
   'When the connector cannot answer, record it',
   'If you have to tell someone this connector cannot reach something - no tool covers it, a tool returned a capability-unavailable error, or the data exists in KLIP or JPS but no tool surfaces it - CALL klip_report_gap before you finish the answer. Pass the question as asked and a short topic. It writes to the gateway''s own gap log, never to KLIP or JPS, and the ranked list is what the team builds from. This matters because the alternative has been a person noticing a weak answer and reporting it by hand: five gaps were found that way this month and in four of them the data was already reachable and the connector was simply not wired to it. Still tell the user plainly that you cannot answer and point them at the source application - logging the gap is in addition to saying so, never instead of it. Do NOT call it when a tool answered and the answer was empty: no vessels alongside is a real result, not a gap.',
   ARRAY['gap','missing','cannot answer','not connected','no tool','feedback','improve','report'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com')
ON CONFLICT (slug) DO UPDATE
  SET body = EXCLUDED.body, title = EXCLUDED.title, tags = EXCLUDED.tags, updated_at = now();

COMMIT;

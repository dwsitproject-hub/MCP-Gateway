-- 008_knowledge_jetty_routing.sql
--
-- Jetty routing enters the pinned preamble, now that a jetty tool actually exists.
--
-- Migration 007 deliberately pinned nothing: an entry telling a model to reach for
-- jetty_* tools that did not exist is the failure that cost this project days on
-- shipping performance. jetty_at_berth shipped on 11 Sep 2026, so the rule now
-- describes a real surface - and says plainly how small that surface still is.
--
-- THE BUDGET IS ZERO-SUM. The preamble caps at 2,000 characters and sat at 1,980, so
-- something had to give. Both KLIP unit entries are unpinned:
--
--   contract-qty-stored-kg (455)      "divide by 1,000"
--   incoterm-outstanding-basis (566)  which quantity each incoterm measures against
--
-- Both were pinned when the MODEL had to do that arithmetic. It no longer does:
-- klip_performance_summary converts to MT and declares units, klip_outstanding reports
-- KLIP's own aggregate, and basisFor applies the incoterm rule in code. They are now
-- explanations rather than instructions, and an explanation is what search is for -
-- "why does my export differ from the gateway" is a question someone ASKS.
--
-- Measured on a fresh PG16 after this file: 1,875 of 2,000, leaving 125.
--
-- The first draft came out at 1,994 with SIX characters spare, which is not a margin -
-- the loop skips an entry that does not fit and orders by updated_at DESC, so the next
-- edit to either routing entry would have silently dropped the KLIP one. Trimmed to
-- leave room for a real change rather than a heroic one.

BEGIN;

UPDATE knowledge_entries SET pinned = FALSE, updated_at = now()
WHERE slug IN ('contract-qty-stored-kg', 'incoterm-outstanding-basis');

-- The 007 availability guard is now WRONG and would do real damage.
--
-- It said "this gateway exposes NO jetty_* tools" and told a model to answer every JPS
-- question with "not connected". That was correct for one day. With jetty_at_berth
-- shipped it would make a model refuse to use a tool it can see - the mirror image of
-- the shipping-performance failure, where an entry promised a capability that did not
-- exist. A stale guard is as harmful as a stale promise.
UPDATE knowledge_entries SET
  title = 'What the gateway can and cannot reach in JPS',
  body = 'This gateway now reaches the Jetty Planning System, but for ONE question only: jetty_at_berth returns the vessels alongside right now, with cargo moved, milestone timestamps and ATG freshness. Everything else JPS holds - occupancy, turnaround, on-time and past-ETC, shipment plans, allocation and the Gantt, trucking-side data, quality surveys, tank farm detail - has NO tool yet. For those, say the connector does not reach them and point at the JPS application; do not answer from the curated JPS entries here, which explain how JPS works and carry no live data, and do not substitute a KLIP tool, which measures different voyages. As of 2026-09-11.',
  updated_at = now()
WHERE slug = 'jetty-connector-not-yet-available';

INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES
  ('jetty-vs-klip-routing', 'preference', 'general',
   'Which system owns a question: KLIP or the Jetty Planning System',
   'Two upstreams, one connector, and both say vessel and shipment - so route on the discriminator, not the noun. KLIP is COMMERCIAL fulfilment across plants: contracts, outstanding, incoterms, contract and shipping performance, oil loss, trucking, quality. JPS is what happens AT A JETTY: berths, vessels alongside, NOR and laytime, cargo operations from tank gauging, sign-off and cast-off. JPS words - berth, jetty, alongside, NOR, laytime, cast-off, ATG, palka, demurrage. KLIP words - contract, outstanding, incoterm, plant, STO, supplier. JPS TOOLS SO FAR: jetty_at_berth ONLY - vessels alongside now, cargo moved, milestone timestamps, ATG freshness. Occupancy, turnaround, on-time, shipment plans and allocation exist in JPS but have NO tool yet: say they are not connected rather than answering them from KLIP, which measures different voyages.',
   ARRAY['routing','jetty','jps','klip','which tool','berth','alongside','vessel'],
   'verified', TRUE, 'curator', 'jerry.hakim@energi-up.com')
ON CONFLICT (slug) DO NOTHING;

COMMIT;

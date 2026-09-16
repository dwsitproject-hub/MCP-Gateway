-- 010_knowledge_tank_farm.sql
--
-- A second jetty tool exists, so the entry that says there is only one has to move.
--
-- THIS IS THE THIRD TIME THIS ENTRY HAS BEEN WRONG IN THE SAME DIRECTION. 007 pinned a
-- guard saying no jetty_* tools existed; 008 corrected it once jetty_at_berth shipped
-- and wrote "jetty_at_berth ONLY"; jetty_tank_farm now makes that false in its turn.
-- Asked about tank farm stock, a model read the preamble and reported - confidently,
-- and citing the gateway's own documentation - that the connector could not reach data
-- it had just been given a tool for, then offered to scrape the JPS UI instead.
--
-- The lesson is not "remember to update the entry". It is that an entry enumerating
-- CURRENT CAPABILITY ages every time the code ships, while an entry describing a
-- DISCRIMINATOR does not. So the tool list here is now written as a short pointer with
-- the durable half - which system owns which question - carrying the weight, and the
-- "ask the tool list" instruction doing the work the enumeration used to do.
--
-- Budget: the preamble caps at 2,000 characters and skips rather than truncates, so an
-- overrun silently drops whichever entry sorts last by updated_at. Measured after this
-- file: 1,876 of 2,000 with 124 to spare. A first draft came in at 1,963 - a 37-character
-- margin, which is not a margin. The loop skips an entry that does not fit and orders by
-- updated_at DESC, so the next edit to either routing entry would have dropped the other.

BEGIN;

UPDATE knowledge_entries SET
  body = 'Two upstreams, one connector, and both say vessel and shipment - so route on the discriminator, not the noun. KLIP is COMMERCIAL fulfilment across plants: contracts, outstanding, incoterms, performance, oil loss, trucking, quality, price. JPS is what physically happens AT A PORT: berths, vessels alongside, NOR and laytime, cargo operations, sign-off and cast-off, SHORE TANK STOCK. JPS words - berth, jetty, alongside, NOR, laytime, cast-off, ATG, palka, demurrage, tank farm, shore tank, ullage. KLIP words - contract, outstanding, incoterm, plant, STO, supplier, unit price. Jetty tools are named jetty_*: READ THE TOOL LIST rather than assume which exist, because it grows. What no jetty_* tool reaches - occupancy, turnaround, on-time, shipment plans, allocation - say is not connected rather than answering from KLIP, which measures different voyages.',
  updated_at = now()
WHERE slug = 'jetty-vs-klip-routing';

-- The searchable companion, same correction. Not pinned, so it costs no budget - but it
-- is what a model finds when it searches "what can the connector reach in JPS", and a
-- stale answer there is just as confident as a stale answer in the preamble.
UPDATE knowledge_entries SET
  title = 'What the gateway can and cannot reach in JPS',
  body = 'This gateway reaches the Jetty Planning System through jetty_* tools, and the set GROWS - check the tool list rather than this entry for what exists today. As of 2026-09-16: jetty_at_berth (vessels alongside now, cargo moved against the shipping instruction, milestone timestamps, ATG freshness) and jetty_tank_farm (shore-tank stock per tank and per product - level, temperature, density, volume, mass, flow rate - the source behind the JPS Tank Farm page). Everything else JPS holds - slot occupancy, turnaround, on-time and past-ETC, shipment plans, allocation and the Gantt, trucking-side data, quality surveys - has no tool yet: say the connector does not reach it and point at the JPS application. Do not answer from the curated JPS entries here, which explain how JPS works and carry no live data, and do not substitute a KLIP tool, which measures different voyages. Scraping the JPS UI is not an alternative: it is the operational system of record with live write endpoints.',
  updated_at = now()
WHERE slug = 'jetty-connector-not-yet-available';

-- Tank farm units, as a searchable entry. Recorded because the payload does not say it
-- and the wrong reading is a 1000x error in a number somebody will act on.
INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES
  ('jps-tank-farm-units', 'definition', 'jetty',
   'What the JPS tank farm columns are actually in',
   'JPS /tank-gauging/latest labels exactly ONE column: observedDensityKgM3. totalObservedVolume and totalMass carry no unit, and reading mass as kilograms when it is tonnes is a thousandfold error in a stock figure. jetty_tank_farm therefore MEASURES it rather than assuming: mass = volume x density is true by definition, so the ratio identifies the units - near 1 means cubic metres and kilograms, near 1000 means the mass column is already tonnes, and anything else is reported as UNKNOWN rather than rounded to the nearer of two wrong answers. The finding travels in units_note on every result, with the number of tanks it was measured over. Read it before quoting or converting. This is the same trap as KLIP quantities, which are kilograms behind a unit field that reads MT.',
   ARRAY['jetty','jps','tank farm','units','mass','volume','density','kg','tonne','stock'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com')
ON CONFLICT (slug) DO UPDATE
  SET body = EXCLUDED.body, title = EXCLUDED.title, tags = EXCLUDED.tags, updated_at = now();

COMMIT;

-- 005_knowledge_plant_dimension.sql
--
-- KLIP changed a dimension underneath us on 9 September 2026 without changing a URL,
-- a response key or a payload shape. The plant filter is now derived from SAP Discharge
-- Destination instead of the master_plants Group Plant mapping, and the vocabulary went
-- from 15 values to 40.
--
-- That is the most dangerous kind of change for this connector, because nothing errors:
-- a retired value like `Cisadane` is ACCEPTED and returns zero rows, indistinguishable
-- from a genuinely empty result or from outright nonsense. A user asking about Cisadane
-- would be told there are no contracts there, which is untrue.
--
-- Our own UNKNOWN_FILTER_VALUE guard is what protects us: klip_reference re-reads the
-- canonical list, so a retired name now fails validation instead of returning a false
-- zero. This file makes the knowledge base agree with that.
--
-- It also corrects two entries this change and their re-testing invalidated, one of
-- which we had written on their earlier advice.

BEGIN;

-- ---------------------------------------------------------------------------
-- The plant dimension changed. Our previous entry now describes the wrong axis.
-- ---------------------------------------------------------------------------
--
-- KLIP: "This supersedes the NEW-F answer we gave you. We told you the canonical plant
-- list collapsed eight TJ.PURA sites into one group plant... That was accurate about
-- Group Plant - but the filters no longer use that dimension, so the caveat you added
-- on our advice now describes the wrong axis."
UPDATE knowledge_entries SET
  title = 'The plant filter is SAP Discharge Destination, not Group Plant',
  body = 'Since 2026-09-09 the plant/region dimension across contracts, trucking, shipments, oil loss and commercial documents is derived from SAP Discharge Destination. The URL and payload did not change - GET /api/contracts/filter-options/group-plants still returns { groupPlants: [...] } - only the values, from 15 to 40. Matching is case-insensitive, so BONTANG and Bontang both work. TWELVE old names have a same-place successor (Bulking Batam->BATAM, Bulking Kumai->KUMAI, TJ PURA->TANJUNG PURA, EOP Tj Morawa->TANJUNG MORAWA, TJ BUTON->TANJUNG BUTON, Bulking Lubuk Gaung->LUBUK GAUNG, Trading->TRADING TRANSIT HO, and Bekasi/Bontang/Belawan/Palembang/Karawang uppercased). THREE are retired with no successor: Bulking Sintang, Cisadane, Tanjung Langsat. The other 28 values are new and finer than Group Plant was, so volume that sat under one entry can now split across several. These are same-place correspondences, NOT a re-key - use them to translate a user''s wording, never to reconcile historic totals. The old vocabulary is still served at /api/contracts/filter-options/master-group-plants if you need to map rather than re-derive. SAP''s KIJING is normalised into TANJUNG PURA, deliberately many-to-one, so collapse them together rather than swapping one for the other. This supersedes the earlier eight-TJ.PURA-sites answer, which was true of Group Plant but is no longer the axis the filters use.',
  updated_at = now()
WHERE slug = 'group-plant-definition';

-- The pinned routing entry carried a one-clause summary of the old axis.
UPDATE knowledge_entries SET
  body = 'Route by vocabulary; never answer one page''s question from another page''s data - different row sets. /contract-performance - contract performance, outstanding qty, on-time vs late, Trade/DP/Cash/Log cycles -> klip_performance_summary, klip_outstanding. /shipping-performance - voyage milestone DELAYS in days (ETA-ETR/ETB/ETC and the ATA equivalents) and how many vessels are on going -> klip_shipping_performance. /oil-loss - oil loss or gain, R1-R4 -> klip_oil_loss. /shipments - shipment status and its eight cards, Pending ATC, per-shipment detail -> klip_shipment_status. /trucking - anything trucking -> klip_trucking_ops. /quality - FFA, moisture, impurity, IV, DOBI -> klip_quality_surveys. PLANT NAMES CHANGED on 2026-09-09: the filter is now SAP Discharge Destination, 40 values, and a retired name such as Cisadane returns ZERO rows silently. Resolve plant names via klip_reference.',
  updated_at = now()
WHERE slug = 'klip-topic-routing';

-- ---------------------------------------------------------------------------
-- The hazard itself, as its own entry
-- ---------------------------------------------------------------------------

INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES

  ('plant-zero-is-not-absence', 'data_caveat', 'general',
   'A zero for a plant may mean the name is retired, not that there is no data',
   'KLIP accepts any plant value and returns zero rows for anything it does not recognise - no error, and nothing in the response distinguishing a retired name, a typo and a genuinely empty result. Measured 2026-09-09: Cisadane 0, TJ PURA 0, Bulking Kumai 0, ZZZNOPE 0, while BONTANG returned 3,469. Never report "no contracts at X" from a zero alone. Resolve the name through klip_reference first; this connector validates plant against the canonical list and raises UNKNOWN_FILTER_VALUE, which is the only thing separating a bad name from an empty answer. Separately, enumerating all 40 values and querying each mostly returns zero legitimately - that is absence of data in the current scope, not a bad value.',
   ARRAY['plant','region','zero','retired','unknown filter value'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('plant-vocabulary-vs-drilldown', 'data_caveat', 'general',
   'The plant vocabulary and what a page shows are two different lists',
   'The 40 plant values are the VOCABULARY - everything the dimension can be. A drilldown shows only values with data in the current scope: under product CPO on Contract Performance, 11 of the 40 appear (BONTANG, TANJUNG PURA, KARAWANG, BATAM, LUBUK GAUNG, BEKASI, TANJUNG MORAWA, PASIR GUDANG, TANGERANG, TRADING TRANSIT HO and Blank). Do not present a short drilldown as the whole dimension, or the vocabulary as places with volume. BLANK MATTERS: contracts with no discharge destination land in a `Blank` bucket that appears in aggregations but NOT in the vocabulary endpoint, so dropping it makes per-region figures fail to sum. Measured 2026-09-09: the 40 values sum to 18,163 contracts against 18,202 unfiltered - the missing 39 are Blank. Note the casing too: vocabulary values are UPPERCASE while the empty-key bucket renders as `Blank`, so an uppercase-only match misses it.',
   ARRAY['plant','region','blank','drilldown','vocabulary','sum'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('shipments-repeat-cost-is-full-price', 'data_caveat', 'shipments',
   'Shipments is slow and a second call is not cheaper',
   'The Shipments endpoint costs roughly 3.7 s plus 790 ms PER ROW returned - measured 2026-09-10 at plant=BONTANG, 5 rows 7.7 s and 25 rows 23.5 s. That is up from 240 ms per row on 28 August; KLIP attributes it to the dataset growing about 2.4x against a query that scales worse than linearly, and measures 55 s for a 100-row page. Unlike every other KLIP page, a repeat call does NOT hit a warm cache: their keep-warm registry passed a duration of 0 for this page load, read that as "instant", and so deleted the cached page before every multi-minute reload. Fixed on their side, awaiting deploy. Until then treat repeat reads as full cost. Practical consequence: ask for only as many shipment rows as will be read, because the status cards, eta buckets and port breakdowns come from data.summary and cover the whole filtered set however few rows are returned.',
   ARRAY['shipments','performance','slow','cache','timeout'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('late-performance-status-only-on-tree', 'business_rule', 'contracts',
   'status filters the contract-performance drilldown, never the summary cards',
   'On /contracts/late-performance/summary the status parameter is explicitly blanked upstream, because that response returns the Open card AND the Close card and cannot pre-filter rows to one status. KLIP measured it on 2026-09-09: openOS and closeQty identical with no status, with status=Open and with status=Close. It DOES work on the drilldown tree, where status=Open returned 36 late rows and status=Close 771, summing exactly to the 807 returned unfiltered. So filter status on the drilldown, and for open-only figures read the Open card, which already counts only open contracts. This corrects an earlier KLIP answer that said the parameter worked but was value-sensitive.',
   ARRAY['status','late performance','summary','tree','filter'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com')

ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Half of the parallel-STO problem is fixed. Only half.
-- ---------------------------------------------------------------------------
--
-- Re-measured on contract 1004031366 (1,300 MT, four STOs) on 2026-09-10:
-- outstanding_quantity now reads 0 on all four rows where it read 1,300,000 each
-- before, so the 4x is gone. contract_qty still repeats the whole contract total.
UPDATE knowledge_entries SET
  title = 'contract_qty on /shipments repeats the contract total per STO row',
  body = 'On the Shipments endpoint, contract_qty carries the WHOLE CONTRACT''S quantity on every STO row belonging to that contract, not the shipment''s own share; sto_quantity holds the real split. Summing contract_qty therefore multiplies by the number of STOs on each contract. PARTIALLY FIXED: outstanding_quantity had the same fault and no longer does - measured on contract 1004031366 (1,300 MT, four STOs) on 2026-09-10, outstanding_quantity now reads 0 on all four rows where each previously read 1,300,000 and the column summed to 5,200 MT. contract_qty still repeats. One thing to watch: 0 on a contract that showed 1,300 MT outstanding may be an over-correction rather than a real zero, and is worth confirming with the KLIP team. For a plant or contract outstanding total use klip_outstanding, which reads KLIP''s own aggregate.',
  updated_at = now()
WHERE slug = 'shipments-outstanding-not-summable';

COMMIT;

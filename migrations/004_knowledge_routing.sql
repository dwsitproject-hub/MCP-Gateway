-- 004_knowledge_routing.sql
--
-- Three things, all curator-owned:
--
--   A. CORRECTS three seed entries from 003 that the KLIP team answered on the day
--      003 was written. One of them is PINNED and wrong, which is the worst
--      combination available: injected into every conversation, carrying the
--      authority of `verified`, and teaching the opposite of the truth.
--
--   B. TOPIC ROUTING. Which KLIP page owns which vocabulary, and therefore which
--      tool answers it. This is pinned, because routing is the one thing an AI
--      cannot look up - it does not know it needs the rule until after it has
--      already answered from the wrong page. That failure cost this project
--      several days: "shipment performance" was answered from contract lateness,
--      and "shipment status for Bontang" from the Shipping Performance endpoint.
--
--   C. FIVE DATA CAVEATS established 28 Aug - 4 Sep 2026, each one a mistake an
--      AI would otherwise make confidently.
--
-- 003 inserts with ON CONFLICT DO NOTHING, so editing it would not reach a
-- database that has already run it. This file therefore UPDATEs by slug, which is
-- correct on a fresh database (003 then 004, ending here) and on an existing one.
--
-- Every UPDATE is guarded on source = 'seed' so a curator's later hand-edit is
-- never silently reverted by a redeploy.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Corrections
-- ---------------------------------------------------------------------------

-- CFR is named in KLIP's basis SQL and blank has an explicit ELSE rule. We had
-- both as unclassified and were EXCLUDING those contracts from outstanding -
-- which dropped precisely the contracts with no movement recorded, the ones
-- sitting at 100% outstanding. Source: sqlContractActualQtySubtractedCase in
-- backend/src/utils/sapIncotermMetrics.ts, quoted by the KLIP team 28 Aug 2026.
UPDATE knowledge_entries SET
  body = 'KLIP computes outstanding against a per-incoterm basis, defined in one SQL CASE: FRC, CIF and CFR use the RECEIVED quantity; LCO and FOB use the DELIVERED (shipped) quantity; everything else, blank included, takes COALESCE(NULLIF(receive, 0), delivery) - received when non-zero, delivered otherwise. No incoterm is unclassified and NONE is excluded. Contract counts across KLIP as at 2026-08: FRC 4,328, LCO 1,806, FOB 912, CIF 161, CFR 8, blank 1. Confirmed from KLIP source by the KLIP team, 2026-08-28.',
  updated_at = now()
WHERE slug = 'incoterm-outstanding-basis' AND source = 'seed';

-- Eight sites, not two - and the rollup is now a decision rather than a caveat.
UPDATE knowledge_entries SET
  body = 'Group Plant is a contract''s destination grouping, resolved from master_plants.group_plant. It is a REPORTING BUCKET, not a site register: the site register is master_plants.plant_name. The single value "TJ PURA" covers EIGHT plants - EUP Biodiesel, Biodiesel Old, Biomass, Edible Oil, General, Oleo Chemical (two spellings) and MPE Edible Oil. Trucking works at site level and distinguishes them; contract reporting rolls them up, and that rollup is the AGREED standard (confirmed by Jerry, KPN Downstream IT, Sep 2026), not a limitation. Never report a group-plant figure as one physical site.',
  updated_at = now()
WHERE slug = 'group-plant-definition' AND source = 'seed';

-- Not a defect: two different columns, and the list is authoritative for anything derived.
UPDATE knowledge_entries SET
  title = 'Contract status: the list and the detail read different columns',
  body = 'The contract LIST surfaces import_status - SAP-derived and normalised to Open / Close. The DETAIL endpoint is literally SELECT * FROM contracts, so it returns the raw lifecycle column, whose CHECK constraint permits exactly six values: Open, Close, Cancelled, ACTIVE, COMPLETED, CANCELLED. Throughout KLIP''s performance layer ACTIVE means OPEN and COMPLETED means CLOSE. So a contract shown as Open in a list and ACTIVE in the detail has not changed state - the reader crossed from the derived view to the stored one. THE LIST IS AUTHORITATIVE for anything derived (shipped, received, outstanding, normalised status, group plant); the detail answers "what is stored". A contract fetchable by id and absent from every list is expected, not a leak. Confirmed by the KLIP team, 2026-08-28.',
  updated_at = now()
WHERE slug = 'contract-status-vocabulary' AND source = 'seed';

-- ---------------------------------------------------------------------------
-- B. The pin trade
-- ---------------------------------------------------------------------------
--
-- The instructions preamble is capped at 2,000 characters, and the four pinned
-- seeds already used 1,865 of it. Pinning is therefore zero-sum.
--
-- shipment-coassignment-invariants (590 chars) is unpinned: it answers "which
-- contracts sail together", a question someone asks EXPLICITLY, so search finds
-- it when it is wanted. Routing is the opposite - it is needed before anyone
-- knows to ask - so routing takes the slot.
UPDATE knowledge_entries SET pinned = FALSE, updated_at = now()
WHERE slug = 'shipment-coassignment-invariants' AND source = 'seed';

-- Unpinned for the same reason: "what is a group plant" is a question someone
-- ASKS, so search reaches it when it is wanted. The half that must be known
-- unprompted - that a plant filter takes a rollup, not a site - is folded into
-- the routing entry as one clause.
UPDATE knowledge_entries SET pinned = FALSE, updated_at = now()
WHERE slug = 'group-plant-definition' AND source = 'seed';

-- Measured after this file: pinned = contract-qty-stored-kg (455) +
-- incoterm-outstanding-basis (566) + klip-topic-routing (957) = 1,978 of the
-- 2,000-character preamble budget, leaving 22. Anything pinned here must be
-- measured first: an entry that does not fit is dropped silently, never reported.

-- ---------------------------------------------------------------------------
-- C. New entries
-- ---------------------------------------------------------------------------

INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES

  -- PINNED. One entry rather than five, because the budget is shared and a
  -- routing table compresses well.
  ('klip-topic-routing', 'preference', 'general',
   'Which KLIP page owns which question, and which tool answers it',
   'Route by vocabulary; never answer one page''s question from another page''s data, they are different row sets. /contract-performance - contract performance, outstanding qty, on-time vs late, Trade/DP/Cash/Log cycles -> klip_performance_summary, klip_outstanding. /shipping-performance - voyage milestone DELAYS in days (Loading ETA-ETR, ETA-ETB, ETB-ETC; Discharge ETA-ETB, ETB-ETC; the ATA equivalents once completed) and how many vessels are on going -> klip_shipping_performance. /oil-loss - oil loss or gain, R1-R4 -> klip_oil_loss. /shipments - shipment status and its eight cards (unplanned, preplanned, planned, at loading port, sailed to disc port, at discharge port, completed, cancelled), Pending ATC, per-shipment detail -> klip_shipment_status. /trucking - anything trucking -> klip_trucking_ops. A plant filter takes a GROUP plant, a reporting rollup that can cover several sites.',
   ARRAY['routing','which tool','contract performance','shipping performance','oil loss','shipment status','trucking','cycle','vessel'],
   'verified', TRUE, 'curator', 'jerry.hakim@energi-up.com'),

  ('shipments-outstanding-not-summable', 'data_caveat', 'shipments',
   'Outstanding quantity on /shipments repeats the contract total per STO row',
   'On the Shipments endpoint, contract_qty and outstanding_quantity carry the WHOLE CONTRACT''S figure on every STO row belonging to that contract, not the shipment''s own share. sto_quantity holds the real per-shipment split. Measured on contract 1004031366 (1,300 MT, four STOs): each row reads outstanding 1,300,000 kg, so summing the column returns 5,200 MT - out by exactly the number of STOs. Never add up that column; for a plant or contract total use klip_outstanding, which reads KLIP''s own aggregate. As of 2026-08-28.',
   ARRAY['shipments','outstanding','quantity','sum','double count'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('oil-loss-is-loss-rows-only', 'data_caveat', 'oil-loss',
   'The oil-loss endpoint returns loss movements only, never all movements',
   'KLIP filters /oil-loss to rows where the received quantity is below the delivered quantity - the query ends AND qty_receive_resolved < qty_delivery_resolved. So its rows are movements that LOST oil, not the movement population. Any rate built on them has a loss-population denominator: it can answer "how large were the losses" but never "what share of movements lost oil". The page defines Oil Loss (MT) = Qty Receive - Qty Delivery, so a negative figure is a loss. Quantities display as MT and are stored as kg. There is no cap and no pagination - the controller reads no request at all - so within the loss population the set is complete. Confirmed by the KLIP team, 2026-08-28.',
   ARRAY['oil loss','denominator','population','loss','gain'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('oil-loss-r1-r4-unlabelled', 'data_caveat', 'oil-loss',
   'R1-R4 on the Oil Loss page are unlabelled, and R1 and R3 are implausible',
   'The Oil Loss page shows four cards R1, R2, R3 and R4 with a TOTAL each. Neither the page nor the API states what the four measurement points ARE - there is no legend, tooltip or dataSources entry - so do not explain them, only report them. Their sample counts differ by two orders of magnitude (13 / 10 / 10 / 3,205) and two of the totals are impossible: R1 reads +18,027,038 MT and R3 -17,962,099 MT, which exceed any plausible volume. Only R4 (3,205 samples, about -741 MT) is usable. Quote R4 if asked, say R1-R3 are not trustworthy, and refer the definitions to the KLIP team. Observed 2026-09-04.',
   ARRAY['oil loss','r1','r2','r3','r4','ratio'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('klip-dates-are-date-only', 'data_caveat', 'general',
   'Midnight-Z values are DATE columns - read the date, never convert to WIB',
   'Values like 2026-07-15T00:00:00.000Z come from PostgreSQL DATE columns (delivery_start_date, delivery_end_date, contract_date and the milestone ladder). A DATE carries no time and no zone; the driver parses it at local midnight, the container runs UTC, and JSON.stringify appends the Z. The calendar date is therefore exact and lossless. Read the date part and discard the time - converting to WIB attaches a time nobody recorded, and any backward shift moves some dates to the previous day. Unrelated to the separate naive-timestamp fault KLIP repaired on 2026-08-27. Confirmed by the KLIP team, 2026-08-28.',
   ARRAY['dates','timezone','wib','utc','midnight'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('milestones-are-a-ladder', 'definition', 'shipments',
   'Vessel milestones are a ladder, not an ETA/ETD pair',
   'KLIP models each voyage as a ladder with an estimate and an actual at every rung: arrival at the LOADING port, berthing, loading start, loading complete, sailing, then arrival, berthing, start and completion at the discharge port. There is no ETA/ETD pair. An estimated arrival that precedes an estimated sailing is CORRECT - both belong to the loading call, one is not a departure and the other a destination. Measured over Bontang: eta_arrival <= eta_sailed on 51 of 52 rows, and eta_sailed <= eta_discharge_arrival on 45 of 45. Reading the ladder as a pair once produced a false defect report of "ETD and ETA swapped, seven for seven". Actuals live in the ata_vessel_* fields; arrival_date and shipment_date are empty on every row. As of 2026-08-28.',
   ARRAY['eta','etd','ata','milestone','ladder','vessel'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('shipments-summary-mixes-units', 'data_caveat', 'shipments',
   'The Shipments status cards count three different things',
   'On the Shipments page, data.summary.status does not sum to data.summary.total, because the cards do not all count shipments. `unplanned` counts CONTRACT rows awaiting a shipment (summary.unplannedTable.contractRows) and `preplanned` counts GROUPS (summary.preplannedTable.groupCount); the other six count shipment rows. Measured for Bontang on 2026-09-04: total 316 shipment rows, status parts summing to 371, with unplanned 19 = 19 contract rows and 0 shipment rows, and preplanned 1 = one group covering 5 contract rows. Report each card as KLIP states it and never present the sum as a shipment total. A residual gap between the six shipment-row cards and the row count is still unexplained and is with the KLIP team.',
   ARRAY['shipments','summary','status','reconciliation','unplanned','preplanned'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('shipments-eta-buckets-are-klips', 'business_rule', 'shipments',
   'Pending ATC and the overdue/due-soon counts are published by KLIP - do not recompute',
   'The Shipments page answers "what is overdue or due soon" itself, and the API returns it under data.summary. etaLoading and etaDischarge each carry five buckets: moreThan7D, dMinus2, d, delay (overdue) and noEta. loadingPortBreakdown gives arrived / berthed / loading / completedLoading and dischargePortBreakdown gives arrived / berthed / unloading. The page also shows a "Pending ATC (Overdue / Due <=7d)" card. These are KLIP''s figures and reconcile with the page, so quote them; do not build a rival count from delivery dates and milestone nulls. Bontang on 2026-09-04: etaLoading delay 8, noEta 14; etaDischarge delay 21, noEta 1.',
   ARRAY['pending atc','overdue','eta','due','shipments','summary'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('trucking-summary-and-date-filter', 'data_caveat', 'trucking',
   'Trucking: four status cards, FRC/LCO only, and dateFrom filters the CONTRACT date',
   'The Trucking page summarises into four buckets - Unplanned, Planned / In Progress, Completed, Cancelled - not the eight the Shipments page uses. Trucking carries the road incoterms only, FRC and LCO, split by 3rd Party and Interco. Its dateFrom/dateTo parameters filter contracts.contract_date, NOT the operation date; that is deliberate, to keep the calendar aligned with the dashboard YTD baseline, so an operation dated outside the requested window is a correct answer. No operation-date filter exists yet (operationDateFrom/operationDateTo requested from KLIP). Caveat measured 2026-09-04: the Outstanding total read 344,277 MT while the Unplanned and Planned cards summed to 346,777 MT, a 2,500 MT gap; the incoterm split does reconcile to 344,277.',
   ARRAY['trucking','status','frc','lco','date filter','contract date'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com')

ON CONFLICT (slug) DO NOTHING;

COMMIT;

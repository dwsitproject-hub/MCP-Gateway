-- =====================================================================
-- 003 — Gateway knowledge base (context & memory for the connector itself)
--
-- WHY: the gateway is used from multiple AI clients (Claude, and later other
-- MCP-capable providers). Knowledge earned in one conversation — business
-- definitions, data caveats, corrections from the KLIP team — dies with that
-- conversation unless the SERVER carries it. These tables are that carrier:
-- provider-agnostic because they travel inside tool results and the MCP
-- `instructions` field, not inside any one vendor's memory feature.
--
-- BOUNDARY: this is the gateway's OWN Postgres (the one already holding OAuth
-- and audit rows). Nothing here touches KLIP; the KLIP adapter remains strictly
-- read-only (S1). Entries are curated NOTES ABOUT data, never data itself, and
-- are served to models as DATA, sanitised like any KLIP free text.
--
-- Lifecycle: proposed -> verified (2 distinct helpful votes, or curator/seed)
--                     -> deprecated (2 distinct outdated votes, or superseded).
-- Only verified+pinned entries reach the MCP instructions preamble; search
-- returns verified first, proposed clearly labelled, deprecated only on request.
--
-- Idempotent, per PM-tool convention.
-- =====================================================================

-- array_to_string() is only STABLE, and a generated column demands IMMUTABLE;
-- this wrapper is safe because text[] -> text with a constant separator cannot
-- actually vary between calls.
CREATE OR REPLACE FUNCTION immutable_tags_text(tags TEXT[]) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(array_to_string(tags, ' '), '') $$;

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id              BIGSERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('definition', 'business_rule', 'data_caveat', 'qa', 'preference')),
  topic           TEXT NOT NULL DEFAULT 'general',
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'verified', 'deprecated')),
  -- Verified+pinned entries are summarised into the MCP instructions preamble.
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('seed', 'ai', 'curator')),
  created_by      TEXT NOT NULL,
  oauth_client_id TEXT,
  supersedes_id   BIGINT REFERENCES knowledge_entries(id),
  helpful_count   INT NOT NULL DEFAULT 0,
  outdated_count  INT NOT NULL DEFAULT 0,
  use_count       BIGINT NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search          TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('english',
                      title || ' ' || body || ' ' || topic || ' ' || immutable_tags_text(tags))
                  ) STORED
);

CREATE INDEX IF NOT EXISTS knowledge_entries_search_idx ON knowledge_entries USING GIN (search);
CREATE INDEX IF NOT EXISTS knowledge_entries_status_idx ON knowledge_entries (status, topic);

-- One vote per user per entry: promotion needs distinct PEOPLE, not repetition.
CREATE TABLE IF NOT EXISTS knowledge_feedback (
  entry_id   BIGINT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  vote       TEXT NOT NULL CHECK (vote IN ('helpful', 'outdated')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, user_id)
);

-- ---------------------------------------------------------------------
-- Seed entries: knowledge established with the KLIP team up to 2026-09-03.
-- Facts, not instructions; each states its own provenance and as-of date.
-- ---------------------------------------------------------------------

INSERT INTO knowledge_entries (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES
  ('group-plant-definition', 'definition', 'contracts',
   'What "Group Plant" means',
   'Group Plant is the destination plant grouping of a contract, resolved from master_plants.group_plant via the contract''s plant code and company (e.g. Bontang, Bulking Batam, Tanjung Pura, Karawang, Cisadane). It is a CONTRACT attribute, not a site register: one group plant can cover several physical sites (KLIP reports one "TJ PURA" while trucking distinguishes EUP EDIBLE OIL TJ.PURA from EUP BIOMASS TJ.PURA). As of 2026-09.',
   ARRAY['group plant','plant_site','master_plants'], 'verified', TRUE, 'seed', 'seed'),

  ('shipment-coassignment-invariants', 'business_rule', 'shipments',
   'Which contracts/POs share one vessel shipment',
   'Measured on all non-Unplanned shipments (2026-07 snapshot, 187 shipments / 109 multi-contract): contracts on the SAME shipment always share Group Plant, Buyer and Incoterm (100% each) and almost always Product (98%; rare deliberate multi-parcel voyages such as CPO+CPKO). Supplier matches only 57%, supplier group 76%, LT/Spot 69% - none of those are grouping rules. Multi-contract consolidation is a FOB behaviour (103 of 105 cases); CIF shipments are almost always single-contract. A contract goes whole onto one shipment ~95% of the time.',
   ARRAY['shipment','grouping','vessel','invariants'], 'verified', TRUE, 'seed', 'seed'),

  ('pre-planned-grouping-rule', 'business_rule', 'shipments',
   'Pre-Planned auto-grouping rule (85.7% backtested precision)',
   'To suggest which Unplanned contracts will sail together: hard key = Group Plant + Buyer + Incoterm + Product; within it, group contracts of the SAME supplier whose delivery windows are within 3 days of each other; then bin-pack outstanding MT into the plant''s MEDIAN historical vessel parcel (Bontang ~2,700 MT, Tanjung Pura ~3,971, Bulking Batam ~2,998, Karawang ~1,000; fallback 3,000). Backtested 2026-07 at 85.7% pairwise precision / 86% of groups fully correct. Window overlap alone is only ~14% precise - do not group on it. Spec: Logistic SAP repo, docs/PRE-PLANNED-GROUPING-SPEC.md.',
   ARRAY['pre-planned','grouping','vessel capacity'], 'verified', FALSE, 'seed', 'seed'),

  ('contract-qty-stored-kg', 'data_caveat', 'contracts',
   'Contract quantities are stored in KG even where unit says MT',
   'In KLIP''s contract data, quantity_ordered and outstanding quantities are stored in kilograms although the unit field often reads MT. Divide by 1,000 for metric tonnes. Cross-check: summed contract KG/1000 matches vessel capacities (2,500-6,000 MT barges). The gateway''s tools already normalise to MT - this note matters when comparing gateway numbers against raw KLIP exports. As of 2026-09.',
   ARRAY['units','kg','mt','quantity'], 'verified', TRUE, 'seed', 'seed'),

  ('incoterm-outstanding-basis', 'business_rule', 'outstanding',
   'Outstanding is computed on a different basis per incoterm',
   'FOB and LCO/LOCO contracts measure fulfilment on a SHIPPED basis; FRC/FRANCO and CIF on a RECEIVED basis. Blank and CFR have no agreed basis yet, so contracts with those incoterms are EXCLUDED from outstanding totals and flagged rather than assumed (classification requested from the KLIP team, 2026-08).',
   ARRAY['incoterm','outstanding','fob','cif'], 'verified', TRUE, 'seed', 'seed'),

  ('contract-status-vocabulary', 'data_caveat', 'contracts',
   'Contract status vocabulary differs between list and detail',
   'The contract LIST reports statuses Open / Close / Cancelled; the contract DETAIL endpoint can return values outside that set, e.g. ACTIVE where the list says Open. Prefer the list vocabulary when filtering. Raised with the KLIP team (2026-08).',
   ARRAY['status','vocabulary','contracts'], 'verified', FALSE, 'seed', 'seed'),

  ('sap-absence-not-cancellation', 'data_caveat', 'sap',
   'A PO missing from the SAP report does not simply mean cancelled',
   'POs drop out of the SAP report when cancelled, but a naive "absent means cancelled" rule is wrong: absence must be judged at PO level (not per STO line), only after the report is trusted as complete for that period, and blank-STO rows add noise. Treat SAP absence as a signal to investigate, not a status. As of 2026-08.',
   ARRAY['sap','cancellation','po'], 'verified', FALSE, 'seed', 'seed'),

  ('vessel-parcel-sizes', 'business_rule', 'shipments',
   'Typical vessel parcel size per group plant',
   'Median BL quantity of completed shipments per destination group plant (2026-07 snapshot): Bontang ~2,700 MT; Tanjung Pura ~3,971 MT; Bulking Batam ~2,998 MT; Karawang ~1,000 MT; fleet is mostly 2,500-6,000 MT barges. Use as the working vessel size when planning; refresh from shipment history, values drift.',
   ARRAY['vessel','capacity','parcel','barge'], 'verified', FALSE, 'seed', 'seed'),

  ('shipments-row-granularity', 'data_caveat', 'shipments',
   'Shipment rows repeat per STO line in KLIP UI exports',
   'KLIP''s shipments views repeat a shipment row per STO/contract line, so naive row counts overcount vessels. Count distinct shipment ids; contract_numbers / po_numbers arrive as comma-separated aggregates on each row. As of 2026-09.',
   ARRAY['shipments','sto','row count'], 'verified', FALSE, 'seed', 'seed')
ON CONFLICT (slug) DO NOTHING;

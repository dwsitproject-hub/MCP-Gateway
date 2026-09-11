-- 007_knowledge_jetty_planning.sql
--
-- Jetty Planning System (JPS) domain knowledge, ahead of the connector itself.
--
-- Decision, 11 Sep 2026: JPS tools will live in THIS gateway under a jetty_* namespace
-- rather than a separate service, reusing the OAuth server, Hub OIDC, audit trail,
-- envelope, route-contract pattern, read-only guard and this knowledge base.
--
-- NOTHING HERE IS PINNED, deliberately. The pinned preamble is where routing lives -
-- which page owns which question, and which tool answers it - and there are no jetty_*
-- tools yet. Pinning a routing rule for tools that do not exist is the exact failure
-- that cost this project several days on shipping performance: an entry promising a
-- capability the connector could not honour. Routing gets pinned in the migration that
-- ships the tools, and the pinned budget gets re-cut then. The current pinned set is
-- untouched at 1,980 of 2,000 characters.
--
-- Every entry below is sourced from the JPS PRD v1.0 and Technical Documentation v1.0
-- (11 Sep 2026, branch sit @ 2b805b3), both first-party - written by the same team that
-- owns the system, not a vendor's description of it.

BEGIN;

INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES

  -- Read this before answering any JPS question from the entries below.
  ('jetty-connector-not-yet-available', 'data_caveat', 'jetty',
   'JPS knowledge exists here, but no jetty tool does yet',
   'This gateway holds curated knowledge about the Jetty Planning System (JPS) but exposes NO jetty_* tools as of 2026-09-11. So these entries can explain what a JPS term means or how a rule works; they can NEVER answer what is happening at a berth right now. If asked for JPS data - which vessels are alongside, occupancy, a voyage''s milestones - say the connector does not reach JPS yet and point at the JPS web application. Do not infer a figure from these definitions. An empty answer is correct here; a derived one is not.',
   ARRAY['jetty','jps','availability','not connected'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-what-it-is', 'definition', 'jetty',
   'What the Jetty Planning System is, and its lifecycle',
   'JPS is the operational system of record for CPO downstream jetty operations across multiple ports: planning vessel calls, allocating berths, executing loading and unloading at berth, clearing vessels for departure. Every vessel call moves through one controlled lifecycle - plan, approval, allocation, berthing, execution, sign-off, departure - with each milestone timestamped and validated. It replaced spreadsheets, chat and paper checklists, so its value proposition is that every dashboard number traces back to a validated record. React 18 SPA over a Node/Express REST API under /api/v1 on PostgreSQL 16, no ORM. Source: JPS PRD v1.0, 2026-09-11.',
   ARRAY['jps','jetty','definition','lifecycle','scope'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-metric-definitions', 'business_rule', 'jetty',
   'JPS canonical metric definitions - quote these, never derive an equivalent',
   'JPS publishes its own metric definitions and they are authoritative. Median waiting to berth = TA to TB per voyage. Median turnaround / berth time = TB to cast-off per voyage, multi-SI deduped by plan. Effective ops ratio = sum of cargo-operations hours divided by sum of berth hours, over sailed voyages. On-time vs ETC = percent of voyages with operations completed at or before ETC. Past estimated completion = operations alongside where now is past ETC. Slot occupancy = distinct alongside plans divided by in-service slot capacity, capped at capacity, with out-of-service jetties excluded from the denominator. Cargo throughput = sum of SI quantity in MT for voyages cast off in the period. Deriving a lookalike figure from raw records instead of using these is how two numbers for one question get born. Source: JPS PRD v1.0 section 2.',
   ARRAY['jps','jetty','metrics','kpi','occupancy','turnaround','definitions'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-voyage-is-the-unit', 'business_rule', 'jetty',
   'A voyage is one shipment plan - dedupe for time, sum for quantity',
   'One physical vessel call is one shipment plan, which may carry several shipping instructions and therefore several operations. TIME metrics count the voyage ONCE - deduped by shipment plan - while QUANTITY metrics SUM across its SIs. Getting this backwards double-counts a multi-SI call in every duration average. Sailed figures are always bucketed by CAST-OFF date, on every page, so a voyage planned in one month and departed in the next belongs to the later one. Shifted-out vessels are excluded from turnaround KPIs, and a sailed vessel is never rendered as Incoming on its cast-off day. Source: JPS PRD v1.0 sections 5 and 8.',
   ARRAY['jps','jetty','voyage','dedupe','cast-off','counting'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-live-vs-range', 'data_caveat', 'jetty',
   'JPS separates live snapshots from range cohorts, and labels every card',
   'JPS states the time basis on every dashboard card and never silently mixes them - one of its explicit product principles is "live is live, range is range". Live Ops is a snapshot of now, refreshed silently every 60 seconds. Ops Analytics is a range cohort. The dashboard endpoints carry the duality directly: a single-day range returns a SNAPSHOT (live if the day is today, otherwise end-of-day) while a multi-day range returns a PER-DAY AVERAGE. So "occupancy" for one day and "occupancy" for a month are different computations, and comparing them as though they were the same measure is wrong. Management Dashboard reconstructs past periods as of period end; live windows say "now". Source: JPS TechDoc v1.0 sections 3.10 and 5.',
   ARRAY['jps','jetty','snapshot','average','live','range','dashboard'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-port-scope-is-mandatory', 'business_rule', 'jetty',
   'Every JPS call is port-scoped, and the caller must be assigned that port',
   'JPS is multi-port and scope is not optional: every /api/v1 request resolves an x-port-id header (or port_id query) and checks it against the caller''s port assignments, with cross-port references rejected inside the handlers as well. A user selects a port after login and every page and API call is scoped to it. This has no equivalent in the KLIP connector, so it is easy to forget: a JPS figure without a port is meaningless, and a service account with no port assignments reads nothing at all regardless of its role. Source: JPS PRD FR-AUTH-3, TechDoc v1.0 section 1.2.',
   ARRAY['jps','jetty','port','scope','x-port-id','multi-port'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-timeline-validation', 'business_rule', 'jetty',
   'JPS validates timestamps at the gate - the ordering rules are fixed',
   'JPS rejects impossible data at entry rather than cleaning it downstream. Every timestamp must fall within 2020-01-01 to now plus two years. TB (actual berthing) must be at or after TA (actual arrival). ETC must be at or after TB. Cast-off must be at or after TB - resolved through a precedence chain of plan TB, plan docking, operation TB, operation docking - and no later than now plus a 15 minute clock-skew allowance. Sub-process entries require start at or before end. Because these are enforced, a JPS timestamp that violates them should not exist; if one appears, treat it as a bug worth reporting rather than as data to reason around. Timestamps are entered in the schedule timezone, stored UTC, displayed per locale. Source: JPS PRD section 8, TechDoc v1.0 section 4.',
   ARRAY['jps','jetty','validation','timeline','eta','etb','etc','cast-off'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-operation-status-machine', 'definition', 'jetty',
   'The JPS operation status machine, and what each transition requires',
   'One operation exists per shipping instruction, and it moves through a fixed machine: PENDING, then DOCKED on start-docking which sets TB, then IN_PROGRESS when cargo operations begin, then POST_OPS at post-checking, then SIGNOFF_REQUESTED on a sign-off request, then SIGNOFF_APPROVED when an approver with the approve permission signs it off, then SAILED on a validated cast-off. Only sign-off-approved operations may depart, and only approved plans reach allocation. Completion percent runs 0 to 100 alongside the status. Source: JPS TechDoc v1.0 section 6.1.',
   ARRAY['jps','jetty','status','operation','lifecycle','signoff','sailed'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-cargo-quantity-sources', 'data_caveat', 'jetty',
   'JPS cargo quantities come from ATG mass deltas, with documented fallbacks',
   'Cargo moved is normally derived from ATG (Automatic Tank Gauging) telemetry: a load line''s quantity is the shore-tank MASS DELTA between the line''s start and end for the selected tank. Manual mode is explicit rather than implied, and manual checkpoints are the contingency when no ATG source exists. Hourly progress falls back to the saved line quantity where an hourly segment under-reports. Reverse movement is DISPLAYED but never subtracted from totals. Progress is moved against SI quantity. Plan vessel capacity is the sum of MT lines plus KL lines times the commodity''s KL-to-MT factor, recomputed whenever an SI is saved; DWT is a generated column and is never entered. So a quantity question needs to say which source it means - ATG delta, manual entry, or SI planned quantity. Source: JPS PRD FR-EXEC-4/5, TechDoc v1.0 section 4.',
   ARRAY['jps','jetty','cargo','atg','quantity','mass delta','kl','mt'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-is-a-system-of-record', 'data_caveat', 'jetty',
   'JPS is operational, not reporting - its API can change real port operations',
   'Unlike KLIP, which reports on contracts, JPS OWNS the vessel lifecycle. Its API carries approve and reject on shipment plans, exception request/approve/reject, sign-off request and approval, and depart - which records a cast-off and sets a vessel SAILED. A write reaching JPS changes what happens at a berth. The connector''s read-only guarantee therefore matters MORE here than it did for KLIP, and it must be structural - the route contract simply not describing a mutation - rather than a convention in the tool layer. Phase 1 is strictly read-only. Source: JPS TechDoc v1.0 sections 3.4, 3.7.',
   ARRAY['jps','jetty','read-only','write','safety','system of record'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('jps-glossary', 'definition', 'jetty',
   'JPS vocabulary: the milestone abbreviations a jetty question will use',
   'ETA and TA are estimated and actual time of ARRIVAL at anchorage. ETB and TB are estimated and actual time of BERTHING - alongside, all fast. POB and SOB are Pilot on Board and Surveyor on Board. ETC is the estimated time of COMPLETION of cargo operations. Cast-off is the vessel releasing moorings and departing the berth. NOR is the Notice of Readiness, tendered then accepted, and acceptance often starts laytime; demurrage is the penalty once the laytime allowance is exceeded. SI is a Shipping Instruction, the cargo document under a shipment plan. ATG is Automatic Tank Gauging. DOBI and IV are CPO quality measures - Deterioration of Bleachability Index and Iodine Value. Palka is Indonesian for a cargo hold or compartment. A voyage is one physical vessel call, which is one shipment plan. Source: JPS PRD v1.0 section 12.',
   ARRAY['jps','jetty','glossary','eta','etb','etc','nor','sob','pob','palka','dobi'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com')

ON CONFLICT (slug) DO NOTHING;

COMMIT;

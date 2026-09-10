-- 006_knowledge_ytd_and_grouping.sql
--
-- Two entries from the 10 September 2026 discrepancy, where a chat reported CPO open
-- outstanding of 480,440 MT against the KLIP page's 422,442 and then analysed the two
-- plants the error inflated most.
--
-- Both causes are now fixed in code - klip_performance_summary defaults to KLIP's YTD
-- window, and group_by aggregates KLIP's own drilldown instead of looping a filter - but
-- the facts are worth holding, because they explain any figure anyone has already taken
-- from this connector and they apply to reading the API directly too.

BEGIN;

INSERT INTO knowledge_entries
  (slug, kind, topic, title, body, tags, status, pinned, source, created_by)
VALUES

  ('contract-performance-needs-a-date-window', 'data_caveat', 'contracts',
   'Without dates the contract-performance endpoint returns ALL TIME, not YTD',
   'KLIP applies no date window unless dateFrom and dateTo are sent, and signals it only by returning ytd_range as {}. The KLIP page always sends 1 January to TODAY - that is what its YTD selector means - so a call without dates produces all-time figures that look like the page''s and are not. Measured 2026-09-10, statusCardSummary.openOutstandingQty for product CPO: no dates KARAWANG 128,462 / BEKASI 31,380 / TANGERANG 5,784 / all plants 475,367, against 1 Jan-10 Sep KARAWANG 90,885 / BEKASI 13,350 / TANGERANG 4,700 / all plants 417,369. A live chat omitted the dates and reported 480,440 MT against the page''s 422,442, then wrote a lateness analysis of Karawang and Bekasi - the two plants the missing window inflated most. klip_performance_summary now defaults to the YTD window and reports period_applied; all_time=true is the explicit opt-out. Note klip_outstanding has no date filter at all and is always a current snapshot, so it never matches a YTD page figure.',
   ARRAY['ytd','date window','all time','contract performance','outstanding'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com'),

  ('per-plant-use-the-drilldown-not-a-loop', 'business_rule', 'contracts',
   'For a per-plant or per-supplier split, aggregate KLIP''s drilldown - never loop a filter',
   'The three trees on /contracts/late-performance/data PARTITION the open outstanding exactly: measured 2026-09-10 for product CPO YTD, late 89,409 + on-track 129,749 + unscheduled 198,211 = 417,369 MT = statusCardSummary.openOutstandingQty. Aggregating the plant level across all three gives 417,368 against 417,369, a 1 MT rounding difference - so summing KLIP''s own nodes reports KLIP''s numbers rather than a second opinion. Use klip_performance_summary with group_by (group_plant, incoterm, product, supplier_group or supplier). Do NOT answer by looping a plant filter over each plant: it took 25 calls, missed the Blank bucket entirely, and produced a total 58,000 MT above KLIP''s own. Two traps in the trees. The UNSCHEDULED tree holds contracts with no resolvable trade cycle and for CPO that is nearly half the outstanding, so omitting it understates badly. And a node with no value at a level has a null key that KLIP renders as `Blank` - it appears in aggregations but never in the filter vocabulary, so it cannot be queried by name and must not be dropped.',
   ARRAY['drilldown','group by','per plant','blank','unscheduled','tree','reconcile'],
   'verified', FALSE, 'curator', 'jerry.hakim@energi-up.com')

ON CONFLICT (slug) DO NOTHING;

COMMIT;

# MCP Gateway — KLIP and Jetty Planning, read-only

One secure service that lets authorized Energi-Up staff query **KLIP** and the **Jetty
Planning System (JPS)** in natural language through Claude, without opening either
application. Strictly read-only toward both.

**Live:** `https://mcp-gw.energi-up.com` (SrvMCP, docker compose, nginx-fronted).
Both upstreams are on **production** as of 14–16 Sep 2026.

**Documents:** [PRD v0.9](docs/MCP_Gateway_Phase1_KLIP_PRD.docx) ·
[TSD v0.9](docs/MCP_Gateway_Phase1_KLIP_TSD.docx) ·
[Implementation guide](docs/MCP_Gateway_Phase1_Implementation_Guide.md) ·
[Design review](docs/MCP_Gateway_Phase1_Review.md) ·
[Deployment runbook](deploy/RUNBOOK.md)

---

## 1. What it exposes

**27 tools.** Every one read-only toward its upstream; the four that write touch only
the gateway's own Postgres.

| Family | Tools |
|---|---|
| **KLIP** (13) | `klip_search_contracts` `klip_get_contract` `klip_outstanding` `klip_shipment_status` `klip_shipping_performance` `klip_performance_summary` `klip_price_summary` `klip_oil_loss` `klip_trucking_ops` `klip_quality_surveys` `klip_payment_status` `klip_sap_import_status` `klip_reference` |
| **JPS** (5) | `jetty_at_berth` `jetty_voyage_history` `jetty_berth_productivity` `jetty_tank_farm` `jetty_vessel_crosscheck` |
| **DWS Hub** (5, admins only) | `dwshub_app_health` `dwshub_sentinel_findings` `dwshub_sentinel_detail` `dwshub_bug_reports` `dwshub_error_trends` |
| **Gateway-local** (4) | `klip_knowledge_search` `klip_knowledge_save` `klip_knowledge_feedback` `klip_report_gap` |

The JPS family is **empty when JPS is unconfigured**. Advertising a tool that always
fails is worse than not advertising it: a model that can see it will reach for it, and
"no JPS connection" arrives as a tool error rather than as an honest absence.

### DWS Hub production support — admins only

The `dwshub_*` family reads what the DWS Hub's **Sentinel** agent has already produced: bug and
JavaScript-error analyses (severity, root cause, proposed fix), per-application health reports, and the
bug reports and error groups behind them. Milo's production-support agent uses it for the daily summary.

- **Source:** the Hub's read-only service API (`/api/service/v1`), with a service key the Hub accepts on
  those GET routes only (`DWSHUB_BASE_URL`, `DWSHUB_SERVICE_KEY`). Not the Hub OIDC login (`HUB_*`).
  Empty when unconfigured, like JPS. Plaintext `http` is refused at boot in production.
- **Admins only.** Sentinel's output is admin-only in the Hub, so the gateway does not widen it to every
  pilot user: the tools are advertised only to callers with `is_admin` (read from the database on every
  request), and the runner refuses them for anyone else, audited as `NOT_ADMIN`.
- **Never starts work in the Hub.** No tool can start an analysis, change a report or spend the Hub's
  Anthropic budget. A proposed code patch stays in the Hub (`has_patch` says one exists).
- **One write, separately keyed.** `dwshub_set_sentinel_model` sets which Claude model the Hub's Sentinel
  uses - nothing else. Milo calls it when the Boss changes Sentinel's model, so both stay in step. It is
  outside the read-only family, needs its own control key (`DWSHUB_CONTROL_KEY`, `hubctl_...`; the read key
  is never sent to the control API), is admin-only, advertises `readOnlyHint: false`, and is absent unless
  that key is set. The Hub accepts only its own model list and audits every change.
- **People are pseudonyms.** The Hub replaces every email with a stable pseudonym before answering.

### The two upstreams answer different questions

Both say *vessel* and *shipment*, so routing is on the discriminator, not the noun.
**KLIP is commercial fulfilment** across plants — contracts, outstanding, incoterms,
performance, oil loss, trucking, quality, price. **JPS is what physically happens at a
port** — berths, vessels alongside, NOR and laytime, cargo operations, cast-off, shore
tank stock.

**There is no join key.** Measured 11 Sep 2026: of 85 JPS shipment plans, **0** carry an
`externalReference`; of 87 shipping instructions, **0** carry a KLIP-shaped STO number.
`jetty_vessel_crosscheck` therefore shows both systems **side by side**, matched on
vessel name, with every candidate carrying its similarity score and nothing merged. The
two genuinely disagree — on 11 Sep JPS had 4 vessels alongside while KLIP showed 12 as
berthed or unloading, overlapping on 2.

One field would fix it: JPS plans already have an empty `externalReference`. Populate it
with the KLIP STO and the join becomes exact. `voyage_no` exists on both sides and is
the nearer-term candidate.

## 2. Pinned versions (T-1)

Where the SDK's docs disagree with the design documents, **the SDK wins**.

| Component | Pinned | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` | **1.30.0** (exact) | OAuth AS, Streamable HTTP, `requireBearerAuth`. |
| MCP protocol revision | **2025-11-25**; wire-compatible with `2025-06-18` | Server is **stateless**, so forward-compatible with `2026-07-28`'s removal of sessions; answers `405` to legacy `GET`/`DELETE` on `/mcp`. |
| Node.js | 22 LTS (`node:22-slim`) | |
| TypeScript | 5.9.3, `strict` + `exactOptionalPropertyTypes` | |
| express | **5.2.1** | SDK depends on `express@^5.2.1`; mixing majors mixes `path-to-regexp`. |
| zod | **4.4.3** | SDK types target zod 4. `.default()` supplies the *output* type. |
| jose | 6.2.9 | RS256 gateway tokens, Hub ID-token verification, admin session. |
| `@node-rs/argon2` | 2.1.0 | Prebuilt binaries — no `node-gyp` in `node:22-slim`. |
| axios | 1.19.0 | Both upstream clients, behind their method guards. |
| pg / PostgreSQL | 8.23.0 / 16 | Managed ApsaraDB over the VPC, not a container. |

## 3. Layout

```
src/
  core/        config, logger, db, audit, cache, rateLimit, semaphore, migrate,
               errors, knowledge, gaps
  adapters/klip/   routes · fields · client(guard) · session · paginate · normalize
  adapters/jetty/  routes · client(GET-only) · session(cookie login)
  tools/klip/      13 read-only tools + shared parameter plumbing
  tools/jetty/     5 read-only tools
  tools/knowledge/ 4 gateway-local tools (memory + gap log)
  mcp/         server, envelope, runner
  auth/        keys, hub(OIDC RP), users, clients, tokens, provider,
               loginPage, adminSession, adminPage
  http/        app, consent(Hub + break-glass), admin(pilot UI), health,
               origin, clientIp
migrations/    001 schema · 002 Hub OIDC · 003 knowledge · 004-008,010 curated
               knowledge · 009 admin flag · 011 capability gaps
deploy/        nginx config, backup sidecar
test/          38 suites, 454 tests, with mock KLIP, mock JPS, mock Hub and mock DWS Hub API
```

Layering rule (T-3): `tools → adapters → core`. Nothing imports `http/` except the
entrypoint and the consent router. All KLIP normalization lives in
`adapters/klip/normalize.ts`, which imports nothing.

## 4. Read-only, twice over

| Boundary | How it is enforced |
|---|---|
| KLIP | `adapters/klip/client.ts` method guard: GET only, plus the single login POST. Exhaustive path/method table in `guard.spec.ts`. |
| JPS | `adapters/jetty/client.ts`, same shape. `JettyRoute` has **no `method` field and no way to express one** — a mutation is not something the layer refuses at runtime, it is something it cannot describe. |
| Credentials | KLIP: a read-only service account. JPS **production**: a view-only role, created 16 Sep before the connector was pointed at it. JPS staging still holds Full Access, so there the client guard is the only layer. |

JPS deserves the belt and braces: it is the operational system of record, and its API
can approve a plan, sign off an operation and record a cast-off that marks a vessel
SAILED.

## 5. Verification is executable, not clerical

Three independent checks, each added after a defect it would have caught.

**`routes:verify-fields`** — probes KLIP and checks every **mapped field** against 50
live rows (10 ids for the detail route), separating ABSENT from sparse. `routes:verify`
alone proves a path resolves and prints twelve key names, which catches a 404 and
almost nothing else. This found the `payments` map matching *nothing* for due date, paid
date and amount, so every payment reported as unpaid, none overdue and all amounts
excluded — without one error.

**`jetty:verify`** — the same for JPS, plus a check of the 21 fields `jetty_at_berth`
reads and a flag for any route an order of magnitude slower than its recorded timing.
This found production returning `summaries` as an object keyed by operation id where
staging returned an array: `for...of` threw *not iterable*, so the tool failed outright
while passing ten tests against a staging-shaped fixture.

**`fieldCoverage.spec.ts`** — fails the build when a mapped field reaches no tool. Found
39, including `shortage` (the tool reported how late a shipment was while silently
holding how much of it failed to arrive) and the eight berthing/start milestones. Fields
deliberately not surfaced live in an allowlist **with a written reason each**, and two
further tests keep that list honest.

**Appendix A remains a hard gate.** With `KLIP_ENV=production` the process refuses to
start while any route is unverified. All 15 KLIP routes were verified against production
on 14 Sep; all 15 JPS routes on 16 Sep (JPS has no boot gate — `jetty:verify` is the
check, and nothing will remind you).

## 6. Where numbers come from

The standing rule: **the source system owns the figure.** Report it, never publish a
rival beside it. Four consequences visible in the code:

- **Units are measured, not assumed.** JPS labels only `observedDensityKgM3`, so
  `jetty_tank_farm` derives what the volume and mass columns are in from
  `volume × density` over the rows it fetched — near 1 means kilograms, near 1000 means
  tonnes, anything else is reported **UNKNOWN** rather than rounded to the nearer of two
  answers a thousand apart. `klip_price_summary` does the same for whether `unit_price`
  is per kilogram (it is — confirmed from KLIP's own SQL, and still measured).
- **Currencies are never mixed.** Production carries IDR and US$; currency is part of
  every price group key.
- **Aggregates say who computed them.** `jetty_berth_productivity` replicates the JPS
  Management Dashboard's own arithmetic — read from `ManagementDashboard.jsx`, because
  JPS serves no KPI endpoint and derives everything in the browser. That means copying a
  dedup by vessel+berthing-time, outlier guards that discard a wait longer than the
  berth stay, and a throughput that sums the **un**deduplicated rows while the medians
  use the deduplicated ones. Any of those guessed differently produces a plausible
  number that does not match the screen.
- **Empty is not zero.** A null milestone means unrecorded, not that the event did not
  happen; a tank with no reading is excluded from a total **and counted**.

### Reading the upstream source

Both systems are checked out locally — JPS at `D:\Claude\Jetty Planning`, KLIP at
`D:\Cursor\Logistic SAP`. Reading them has overturned something every time:

| Assumption | What the source said |
|---|---|
| Dashboard KPIs come from an endpoint | They are computed in the browser from `/operations` |
| `/operations` has no cast-off filter | `cast_off_from` exists and filters server-side — replaced a 120-day lookback guess |
| The plan-ETA window was "unverified" | Confirmed: `COALESCE(sp.eta, o.created_at)`, half-open on the upper bound |
| `unit_price` basis unknown | `contract_value = quantity_ordered × unit_price`, so **per kilogram** |
| `outstanding_qty_planning` ambiguous | A different question: contract minus what is *assigned to STOs*, clamped at zero. Surfaced as `unplanned_qty_mt` |

## 7. Authentication — Downstream Hub OIDC

Pilot users sign in with **Downstream Hub**. The gateway remains the authorization
server Claude talks to; the Hub is one step inside its own `/authorize` flow.

```
Claude ──/authorize──▶ gateway ──302──▶ Downstream Hub ──302──▶ /authorize/hub/callback
                          │        validate id_token (sig/iss/aud/nonce)   │
                          │        check the pilot ALLOWLIST               │
                          └──302 code──▶ Claude ──/token──▶ gateway token (klip:read)
```

We deliberately do **not** use `ProxyOAuthServerProvider`: proxying would hand Claude a
*Hub* token, breaking the RFC 8707 audience binding and moving token issuance out of our
control so the S8 kill switch could no longer invalidate live sessions.

**Authentication is not authorization.** The Hub proves who someone is; the `users`
table decides whether they may use the connector. Phase 1 uses one shared KLIP service
account, so every admitted user can read everything it can — pilot membership *is* the
data-access control, capped at 15.

**Register the gateway's own Hub client — never reuse KLIP's.** The gateway validates
`aud` against its own `HUB_CLIENT_ID`; sharing KLIP's id would mean an ID token minted
during a KLIP login is accepted by the gateway, which is the confused-deputy shape.

### What DWS Hub requires (it is not vanilla OIDC)

| | DWS Hub |
|---|---|
| Client type | **public**, PKCE S256, `token_endpoint_auth_methods_supported: ["none"]` — no secret exists |
| Discovery | `/api/sso/.well-known/openid-configuration` — **not** the RFC 8414 path |
| Token body | **JSON**; form-encoded returns `unsupported_grant_type` |
| Scopes | `openid profile email` only — no groups claim, so `HUB_REQUIRED_GROUP` is unusable |
| **Nonce** | **sent and never echoed back.** See below. |

**`HUB_REQUIRE_NONCE`** defaults to `true` and production runs it `false`. OIDC Core
3.1.3.7 says a nonce that was sent must come back; DWS Hub accepts the parameter and
drops it. An **absent** nonce is configurable; a **wrong** one stays fatal either way,
is logged at error, and a test asserts the flag cannot widen into skipping the check.
What still guards the flow: the authorization code arrives over the back channel, PKCE
S256 binds it to this client, and `state` is single-use.

### Environment pairing, enforced at boot

- `KLIP_ENV=production` + a testing `HUB_ISSUER` → **refuses to start.** Anyone able to
  create a test-Hub account would otherwise reach real commercial data.
- `KLIP_ENV=staging` + the production Hub → warns and continues.

`hub:check` prints the pairing, the discovery result and the exact redirect URI to
register. Note it infers "production Hub" from the *absence* of test/staging/uat/dev in
the hostname, so `dwshub.kpndomain.com` reads as production either way — confirm the
instance by hand.

### Local apps (Milo) — loopback redirects

A local app such as Milo receives its authorization code on `http://127.0.0.1:<port>`
(RFC 8252). That is accepted **only** for clients an admin pre-registers from a shell
with `ALLOW_LOOPBACK_REDIRECTS=true` — dynamic registration at `/register` never accepts
a loopback redirect, whatever the flag says. Only the literal `127.0.0.1` counts, never
`localhost`. The person still signs in with the Hub and must be on the pilot list.

```bash
docker compose exec -T gateway node dist/cli.js client:add "Milo – Atlas" http://127.0.0.1:4242/api/gateway/callback
```

Three operational consequences of a local app, none of them visible in its code:

- **It shares its user's rate limit.** `RATE_LIMIT_USER` is keyed on the OAuth subject,
  30 calls per 5 minutes. Agents signing in as a person share that bucket with each
  other *and* with the person's own Claude — an agent loop can 429 the human.
- **It calls the public endpoint from the corporate network**, the egress path that has
  been intermittently blocked. Token refresh and every `/mcp` call depend on it.
- **It conflicts with the planned `/mcp` source-address allowlist** in
  `deploy/nginx/mcp.conf`, which admits only Anthropic's egress. See the comment there.

There is no per-client off-switch yet. Turning the flag off blocks new sign-ins only;
cutting off one app today means `user:disable` on its person or the kill switch.

### The break-glass account

Exactly one local password account, for when the Hub is down or misconfigured. Forces a
password change at first use; every sign-in is audited at high severity. Keep it on a
**separate address** from any person's pilot account — sharing one makes break-glass use
indistinguishable from everyday login, and the alarm stops meaning anything.

`user:clear-break-glass` demotes an account back to Hub-only and **removes the password
hash**; `enable` refuses to restore a break-glass account while another is active.

## 8. The admin UI — `/admin`

Server-rendered, no JavaScript, no external assets. Three checks stand between the
internet and it:

| Check | Question |
|---|---|
| Downstream Hub | who are you |
| pilot list | may you use the connector |
| **`is_admin`** | may you change who else can |

The third is granted **only** by `user:grant-admin` from a shell. There is deliberately
no route that sets it, and a test asserts no such route exists — a public page that can
promote its own callers is a self-service door, and this host takes automated `/admin`
and `formLogin` probes continuously.

The session is a 30-minute signed JWT with no table behind it, and `is_admin` is re-read
from the database **on every request**, so revoking takes effect on the next click. CSRF
is bound to the session and echoed in hidden fields rather than carried in a second
cookie.

It shows the pilot list (add / disable / enable, disabling also revokes live tokens) and
the **capability gap log** — see below.

> nginx must proxy `/admin` and must **not** add its own CSP there. Two CSP headers are
> intersected by the browser, and the server-level `default-src 'none'` cancels the
> app's `style-src 'unsafe-inline'`, which renders as "the CSS didn't load".

## 9. Knowledge base and the gap log

**Knowledge base** (003–008, 010): the connector's own provider-independent memory, so a
fact established once reaches every future conversation. Three channels — the MCP
`instructions` preamble (verified **and** pinned entries, ~2 KB budget, skip-not-truncate
so an overrun silently drops an entry), `klip_knowledge_search`, and the save/feedback
write path. An AI-saved entry is `proposed` until **two distinct users** vote it helpful.

> Entries that **enumerate current capability** go stale every time code ships. That
> happened three times with the jetty tool list, the last time telling a user the
> connector could not reach the tank farm hours after the tool shipped. The pinned entry
> now carries the durable half — which system owns which question — and says *read the
> tool list*, which is generated from code and cannot drift.

**Capability gap log** (011): what the connector was asked for and could not answer.
Three ways in — `klip_report_gap` called by a model that has to say "cannot reach that"
(the only one the gateway cannot detect itself, because when no tool covers a question
nothing is called and nothing fails), an empty knowledge search, and a tool throwing
capability-unavailable. Ranked on `/admin`, most asked first, with up to three of the
actual questions.

**It stores question text**, deliberately. Resolving a gap keeps the count and **deletes
the questions**; text past 90 days is cleared by the housekeeping sweep regardless.
Recording is best-effort and swallows its own failures — a gap is a note about a failure
that already happened, and the log must not become a second one.

## 10. Quick start (local)

```bash
npm ci
docker run -d --name mcpgw-devdb -e POSTGRES_DB=gateway -e POSTGRES_USER=gateway \
  -e POSTGRES_PASSWORD=devpassword -p 127.0.0.1:55432:5432 postgres:16-alpine
cp .env.example .env.dev   # PUBLIC_URL=http://localhost:8787, DATABASE_URL=...55432...
npx tsx test/fixtures/mockKlip.ts 5099 &
set -a; . ./.env.dev; set +a
npm run migrate
npx tsx src/index.ts
```

## 11. Tests

```bash
npm test     # 38 suites, 454 tests
```

Highlights rather than an inventory — the full list is the directory:

| Suite | Covers |
|---|---|
| `normalize.spec.ts` | Incoterm × status × null matrix, kg→MT, rounding order, negative outstanding, WIB |
| `guard.spec.ts` / `jettyGuard.spec.ts` | Exhaustive method/path tables: **no non-GET reaches either upstream** |
| `fieldCoverage.spec.ts` | Every mapped field reaches a tool, or is allowlisted with a reason |
| `integration.spec.ts` | All KLIP tools against mock KLIP, including the prompt-injection drill |
| `hub*.spec.ts` (6 suites) | DWS Hub modelled exactly, plus forged/expired/foreign-key/wrong-audience tokens and the nonce cases |
| `adminUi.spec.ts` / `adminCallback.spec.ts` | The four ways into `/admin` that must stay shut; no route can grant admin |
| `breakGlass.spec.ts` | Exactly one active break-glass account, both directions |
| `internalAddress.spec.ts` | RFC1918 by parsing, not string prefixes |
| `gaps.spec.ts` | The retention promise as implemented |
| `jettyTankFarm.spec.ts` | Units inferred as kg, tonnes, or honestly UNKNOWN |
| `vesselCrosscheck.spec.ts` | Why an 80% name threshold alone is unsafe |

The mocks reproduce the real systems' quirks on purpose: kilograms labelled MT, mixed-
language statuses, a `limit` silently clamped to 100, JPS's bare-array and keyed-object
envelopes, a login that returns its token only in a cookie, and a contract carrying a
prompt-injection payload.

## 12. Deploy

Full procedure: **[deploy/RUNBOOK.md](deploy/RUNBOOK.md)**.

```bash
cd /opt/mcp && git pull
docker compose up -d --build --force-recreate gateway
docker compose exec -T gateway node dist/cli.js migrate
curl -fsS http://127.0.0.1:8787/healthz | python3 -m json.tool
```

> **`.env` is read at container CREATE time.** `docker restart` reuses the old values,
> and plain `up -d` does not reliably notice an `.env` edit — it reports "Running" and
> leaves it. Use `--force-recreate`, then verify with
> `docker compose exec -T gateway printenv <VAR>`.

> **Adding a tool needs a client reconnect.** Claude caches the tool list above the
> conversation, so a new chat alone will not see it.

Admin CLI runs **inside the container** (the host has Docker only, no Node):

```bash
docker compose exec -T gateway node dist/cli.js user:list
docker compose exec -T gateway node dist/cli.js user:grant-admin someone@energi-up.com
docker compose exec -T gateway node dist/cli.js audit:summary --days 7
docker compose exec -T gateway node dist/cli.js routes:verify-fields   # KLIP
docker compose exec -T gateway node dist/cli.js jetty:verify           # JPS
```

Use `docker compose run --rm gateway …` instead when the container is crash-looping and
cannot be exec'd into — which is how a failed boot gate presents.

**Kill switch (S8)** — target under 5 minutes:

```bash
docker compose exec -T gateway node dist/cli.js tokens:revoke-all --reason "incident 2026-xx"
docker compose stop gateway
```

## 13. Still outstanding

- **Verify production figures against the KLIP UI.** The payment map, the contract-
  quantity merge, the enum records and eighteen milestones all changed against data they
  had never seen. The standing rule is that the connector and the page never disagree;
  that has not been checked since.
- **Open with the KLIP team:** `contract_qty` repeating identically on every STO row
  (the 4× summing trap); `is_delayed` false on every row while the page marks shipments
  Late; `sla_days` / `sfal_qty` / `sfbd_qty` empty everywhere; a negative `avgLogCycle`;
  trucking summary 344,277 vs cards 346,777. **Each is now answerable from the KLIP
  source rather than by round trip.**
- **JPS staging still runs on `JPS Full Access`** — production is view-only, staging is
  not, so there the GET-only client is the only layer.
- **Off-host backup sync and a tested restore** — the sidecar writes locally only.
- **Corporate egress CIDRs** in `deploy/nginx/mcp.conf`, then enable the guard on
  `/admin` (a better home for it than `/authorize`, which must work wherever a pilot
  user opens Claude).
- **Load test** at the 30-concurrent-user NFR.
- Decide whether to set `BREAK_GLASS_ENABLED=false` now the Hub path is proven.
- `oilLoss` returns its whole dataset unpaginated — 4,092 rows on 16 Sep, an order of
  magnitude past staging. The cache is what keeps it inside the latency target.

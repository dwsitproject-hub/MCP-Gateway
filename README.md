# MCP Gateway — Phase 1 (KLIP, read-only)

A single secure service that lets authorized Energi-Up staff query KLIP in natural
language through Claude, without opening the application. Strictly read-only.

**Deployment target** (PRD Q3, now closed): `<gateway-hostname>` -> `<gateway-public-ip>`
(ECS-MCP, ap-southeast-5). Note the hostname is **mcp-gw**, not the `mcp.example.com`
the v0.9 documents assumed; the PRD/TSD should be updated to match.

**Documents:** [PRD v0.9](docs/MCP_Gateway_Phase1_KLIP_PRD.docx) ·
[TSD v0.9](docs/MCP_Gateway_Phase1_KLIP_TSD.docx) ·
[Implementation guide](docs/MCP_Gateway_Phase1_Implementation_Guide.md) ·
[Design review](docs/MCP_Gateway_Phase1_Review.md) ·
[Deployment runbook](deploy/RUNBOOK.md)

---

## 1. Pinned versions (T-1)

The MCP spec revision and SDK version are pinned here. Where the SDK's own docs
disagree with the design documents, **the SDK wins** — it defines the exact API.

| Component | Pinned | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` | **1.30.0** (exact, no caret) | Published 27 Jul 2026. Supplies the OAuth AS, the Streamable HTTP transport and `requireBearerAuth`. |
| MCP protocol revision | **2025-11-25** implemented; wire shape compatible with `2025-06-18` clients | Revision `2026-07-28` (draft) removed protocol-level sessions, the GET stream and `Last-Event-ID`. This server is **stateless**, so it is forward-compatible with that change and answers `405` to legacy `GET`/`DELETE` on `/mcp`. |
| Node.js | 22 LTS (`node:22-slim`) | |
| TypeScript | 5.9.3, `strict` + `exactOptionalPropertyTypes` | |
| express | **5.2.1** | Raised from the TSD's 4.x: the SDK depends on `express@^5.2.1`, and mounting an express-5 router into an express-4 app mixes `path-to-regexp` majors. |
| zod | **4.4.3** | Raised from the TSD's 3.x: the SDK's type definitions target zod 4. Note `.default()` now supplies the *output* type. |
| jose | 6.2.9 | RS256 gateway tokens. |
| `@node-rs/argon2` | 2.1.0 | Substituted for `argon2`: prebuilt binaries, so no `node-gyp` toolchain in `node:22-slim`. |
| axios | 1.19.0 | KLIP client, behind the method guard. |
| pg | 8.23.0 | |
| PostgreSQL | 16 (container) | |
| nginx | nginx.org mainline | Config in `deploy/nginx/mcp.conf`. |

## 2. Layout

```
src/
  core/       config, logger, db, audit, cache, rateLimit, semaphore, migrate, errors
  adapters/klip/  routes(APPENDIX A) · fields(APPENDIX A) · client(guard) · session · paginate · normalize
  tools/klip/ 9 tool definitions + shared parameter plumbing
  mcp/        server, envelope, runner
  auth/       keys, hub(OIDC RP), users, clients, tokens, provider, loginPage
  http/       app, consent(Hub + break-glass), health, origin, clientIp
migrations/   idempotent SQL (001 schema, 002 Hub OIDC)
deploy/       nginx config, backup sidecar
test/         120 tests + mock KLIP and mock Hub fixtures
```

Layering rule (T-3): `tools → adapters → core`. Nothing imports `http/` except the
entrypoint. All business normalization lives in `adapters/klip/normalize.ts`, which
imports nothing, so it is unit-testable in isolation.

## 3. Authentication — Downstream Hub OIDC

Pilot users sign in with **Downstream Hub** (OIDC). The gateway remains the
authorization server that Claude talks to; the Hub is one step inside its own
`/authorize` flow.

We deliberately do **not** use the SDK's `ProxyOAuthServerProvider`. Proxying would
hand Claude a *Hub* token, which would break the RFC 8707 audience binding, give
Claude broader Hub scopes than `klip:read`, and move token issuance out of our
control so the S8 kill switch could no longer invalidate live sessions.

```
Claude ──/authorize──▶ gateway ──302──▶ Downstream Hub ──302──▶ /authorize/hub/callback
                          │                                              │
                          │        validate id_token (sig/iss/aud/nonce)  │
                          │        check the pilot ALLOWLIST              │
                          ◀──────────────────────────────────────────────┘
                          └──302 code──▶ Claude ──/token──▶ gateway token (klip:read)
```

**Authentication is not authorization.** The Hub proves who someone is; the
`users` table decides whether they may use the connector. Phase 1 uses one shared
KLIP service account, so every admitted user can read everything `MCP_READONLY`
can read (review H8) — pilot membership *is* the data-access control. A Hub account
that is not on the list gets a 403, and the `<= 15` cap is enforced by `user:add`.

Two PKCE exchanges run in the flow; do not conflate them. Claude's own
`code_challenge` protects the Claude→gateway leg (handled by the SDK); a separate
verifier the gateway keeps server-side protects the gateway→Hub leg.

### Which Hub client? The gateway's own — not KLIP's

Register a **new OIDC client for the MCP Gateway**. Do not reuse KLIP's Hub
registration, even though KLIP is already registered in the testing DWS Hub.

The Hub only touches one of the two trust boundaries:

| Boundary | Credential | Hub involved? |
|---|---|---|
| Claude → gateway (which human is asking) | gateway's own Hub client + the pilot allowlist | **yes** |
| gateway → KLIP (reading data) | `svc-mcp` against KLIP's `/api/auth/login` | **no** — PRD §7 excludes it explicitly |

Reusing KLIP's client breaks the first boundary in a concrete way. The gateway
validates the ID token's `aud` against its own `HUB_CLIENT_ID`; sharing KLIP's
client id means **an ID token minted during a KLIP login would be accepted by the
gateway**, which is the confused-deputy shape. Separate clients are what make the
two relying parties distinguishable. It also keeps the redirect-URI allowlists,
client secrets, rotation schedules, Hub SSO audit entries, and disable switches
independent — turning the connector's Hub client off must not take KLIP login down.

None of this needs any change on the KLIP side. K1–K4 are unaffected.

### Two Hub instances, two registrations

Register the gateway separately in each Hub and pair them with the matching KLIP:

| Stage | KLIP_ENV | HUB_ISSUER | Client |
|---|---|---|---|
| 4–6 (build, staging UAT) | `staging` | testing DWS Hub | gateway client in the **testing** Hub |
| 7+ (production cutover) | `production` | production Hub | a **separate** gateway client in the **production** Hub |

The pairing is enforced at boot, because getting it wrong in one direction is
dangerous rather than untidy:

- `KLIP_ENV=production` + a testing `HUB_ISSUER` → **the gateway refuses to start.**
  Anyone able to create a test-Hub account would otherwise reach real commercial data.
- `KLIP_ENV=staging` + the production `HUB_ISSUER` → warns and continues.

`hub:check` prints the pairing it detected, so the cutover is verifiable:

```
pairing:       KLIP staging  <->  Hub testing
```

### What DWS Hub requires (it is not vanilla OIDC)

Per `Docs/SSO-TARGET-APP-INTEGRATION.md`. Four of these differ from the defaults an
OIDC client library assumes, and three would fail outright:

| | DWS Hub |
|---|---|
| Client type | **public**, PKCE S256 — `token_endpoint_auth_methods_supported: ["none"]`, **no client secret exists** |
| Discovery | `/api/sso/.well-known/openid-configuration` — **not** the RFC 8414 path from the issuer |
| Token body | **JSON**; form-encoded returns `unsupported_grant_type` |
| Scopes | `openid profile email` only — no groups claim, so `HUB_REQUIRED_GROUP` is unusable |
| `redirect_uri` | mandatory in the token request and byte-exact |

Hence `HUB_DISCOVERY_URL` is configured explicitly, `HUB_CLIENT_SECRET` is optional,
and `HUB_TOKEN_BODY` defaults to `json` with a one-shot fallback to form on
`unsupported_grant_type` (logging which worked, so it can be pinned).

### Setting it up

1. Register the gateway as an OIDC client in the Hub with redirect URI
   `<PUBLIC_URL>/authorize/hub/callback`. It is a **public client** — do not ask for
   a secret.
2. Put `HUB_ISSUER`, `HUB_DISCOVERY_URL` and `HUB_CLIENT_ID` in `/opt/mcp/.env`.
3. Verify before any pilot user tries:
   ```bash
   docker compose exec -T gateway node dist/cli.js hub:check
   ```
   This prints the redirect URI to register, runs discovery, and warns if the Hub
   does not advertise S256 PKCE. The gateway also probes discovery at boot and
   reports it in `/healthz` as `hub_oidc`.
4. Add pilot users (no passwords — the Hub authenticates them):
   ```bash
   docker compose exec -T gateway node dist/cli.js user:add someone@example.com "Their Name"
   ```

### The break-glass account

Exactly one local password account is permitted, for use when the Hub is down or
misconfigured:

```bash
docker compose exec -T gateway node dist/cli.js user:add-break-glass it-emergency@example.com
```

It is hidden behind a disclosure on the login page, forces a password change at
first use, and every sign-in through it is audited with `break_glass: true` at high
severity. A Hub-authenticated user cannot use the password path at all, so turning
the Hub off is not a way to fall back to a password nobody set.

Set `BREAK_GLASS_ENABLED=false` once the Hub path is proven in production to remove
the password surface entirely.

### Optional group gate — not available on DWS Hub

`HUB_REQUIRED_GROUP` adds a second check against a groups claim. **DWS Hub does not
issue one** (it advertises only `openid profile email`), so setting it would refuse
every user. `hub:check` warns if you do. The pilot allowlist in the `users` table
remains the authorization control.

### IdP-initiated login

The Hub can push a user straight to a callback from its dashboard tile. That cannot
work for a connector: the callback exists to complete an authorization request Claude
started, so arriving without one leaves nothing to issue a code against. The gateway
detects it and says "start from Claude instead" rather than failing as "sign-in
expired".

## 4. Quick start (local)

```bash
npm ci
docker run -d --name mcpgw-devdb -e POSTGRES_DB=gateway -e POSTGRES_USER=gateway \
  -e POSTGRES_PASSWORD=devpassword -p 127.0.0.1:55432:5432 postgres:16-alpine
cp .env.example .env.dev   # then edit: PUBLIC_URL=http://localhost:8787, DATABASE_URL=...55432...
npx tsx test/fixtures/mockKlip.ts 5099 &      # mock KLIP, behaves like the real one
set -a; . ./.env.dev; set +a
npm run migrate
npx tsx src/index.ts
```

Create a pilot user (works with a TTY or piped input):

```bash
printf 'a-strong-password\na-strong-password\n' | npx tsx src/cli.ts user:add you@example.com "Your Name"
```

## 5. Tests

```bash
npm test
```

| Suite | Covers |
|---|---|
| `normalize.spec.ts` (33) | The Incoterm × status × null matrix, kg→MT, rounding order, negative outstanding, WIB timestamps |
| `guard.spec.ts` (9) | Exhaustive method/path table for T-6, traversal and origin escapes |
| `envelope.spec.ts` (12) | T-5 envelope, truncation `next_step`, injection-payload defusing |
| `truncation.spec.ts` (4) | A bounded fetch publishes `totals_partial`, never `totals` |
| `integration.spec.ts` (23) | All 9 tools against mock KLIP; **no non-GET ever reaches KLIP**; 401 re-login; `AUTH_DEGRADED`; typed errors; unit discipline |
| `resource.spec.ts` (6) | RFC 8707 audience binding: only this server's canonical resource is accepted |
| `audit.spec.ts` (8) | S5 redaction — aggressive on strings, inert on numbers |
| `hub.spec.ts` (20) | Hub OIDC against a mock provider: discovery issuer mismatch, foreign signing key, wrong issuer/audience, expired token, **missing and replayed nonce**, no-email claim |
| `hubGroupGate.spec.ts` (5) | `HUB_REQUIRED_GROUP` admission, including near-miss group names |
| `hubPairing.spec.ts` (5) | Production KLIP behind a testing Hub refuses to boot; the normal pairings do not |
| `hubTokenAuth.spec.ts` (7) | Token-endpoint auth method chosen from discovery, including post-only and public-client Hubs |
| `hubDws.spec.ts` (16) | **DWS Hub modelled exactly**: `/api/sso` discovery, public client, JSON-only token body, no groups scope, plus the encoding fallback both ways |

The mock Hub is a working mini-OIDC provider — real discovery document, real JWKS,
real RS256 ID tokens, and PKCE verification on the authorization code — with every
knob needed to forge a *bad* token, because the negative cases are the point.

The mock KLIP fixture deliberately reproduces the real system's quirks: kilograms
labelled MT, mixed-language statuses, an incoterm outside the standard four, null
quantities, an over-delivered contract, a `limit` **silently clamped to 100**, and a
contract remark carrying a prompt-injection payload.

## 6. Deploy

Full host-specific procedure, with the real IP, hostname and security-group table:
**[deploy/RUNBOOK.md](deploy/RUNBOOK.md)**.

```bash
# on ECS-MCP
cd /opt/mcp && git pull
docker compose build gateway && docker compose up -d
curl -fsS http://127.0.0.1:8787/healthz
```

Admin CLI — note this runs **inside the container**, because the host installs
Docker only and has no Node.js:

```bash
docker compose exec -T gateway node dist/cli.js user:list
docker compose exec -T gateway node dist/cli.js audit:summary --days 7
docker compose exec -T gateway node dist/cli.js audit:export --from 2026-08-01 --to 2026-09-01 --out /tmp/audit.csv
docker compose exec -T gateway node dist/cli.js routes:verify        # probes KLIP, reports Appendix A gaps
```

**Kill switch (S8)** — target under 5 minutes:

```bash
docker compose exec -T gateway node dist/cli.js tokens:revoke-all --reason "incident 2026-xx"
docker compose stop gateway
```

Break-glass if the app container is unhealthy:

```bash
docker compose exec -T db psql -U gateway -d gateway -c "UPDATE oauth_tokens SET revoked_at=now() WHERE revoked_at IS NULL;"
```

## 7. Appendix A is a hard gate

`src/adapters/klip/routes.ts` and `src/adapters/klip/fields.ts` hold every KLIP path,
query-parameter name, page-size ceiling, response field name and enum value the
adapter depends on. **Every entry is currently unverified.**

The gate is executable, not clerical: with `KLIP_ENV=production` the process
**refuses to start** while any route is unverified. Run `routes:verify` against
staging, record the results, set `verified: true` per route and `enums.verified = true`.

Two fields matter more than the rest:

- `maxLimit` — the largest `limit` KLIP actually accepts. If it silently clamps to
  100, a `KLIP_PAGE_SIZE` of 1000 turns one page into ten and breaks the latency target.
- `enums.*` — the canonical status and incoterm values. Anything unmapped is excluded
  from totals with a data-quality note, never defaulted.

## 8. Deviations from TSD v0.9

Each one comes from the [design review](docs/MCP_Gateway_Phase1_Review.md) and is
commented at its call site.

| # | Change | Why |
|---|---|---|
| B3 | Origin rejected only when **present and invalid** | The spec requires 403 only for a present-and-invalid Origin. Claude calls the connector server-to-server and may send none; rejecting absent would 403 every tool call. |
| B4 | `aud` = `<PUBLIC_URL>/mcp`, not the bare hostname | RFC 8707 audience binding. Added `authorization_servers` + `resource` to the PRM document, `scope` on the 401 challenge, and RFC 9207 `iss`. |
| B5 | **Stateless** transport; identity from the token per request | Revision 2026-07-28 removed protocol sessions. T-4 is satisfied by construction — there is no session to hijack. |
| B6 | Kill switch runs `docker compose exec` | The host has no Node.js, so `cd /opt/mcp && node cli.js` could never work. |
| B7 | nginx is the anti-abuse floor; per-user limit keyed on the OAuth `sub` | All traffic arrives from Anthropic's shared egress range, so IP-keyed limiting puts the whole pilot in one bucket. Added `limit_req_status 429` (the default is 503). |
| H1 | OAuth built on the SDK's `mcpAuthRouter` + `OAuthServerProvider` | The SDK ships the AS, including revocation and default rate limiting. Only storage and user authentication are ours. |
| H2 | **Downstream Hub OIDC is the login path**, with one break-glass local account | Brought forward from Phase 2. The Hub authenticates; the users table stays the pilot allowlist. `ProxyOAuthServerProvider` was rejected on purpose — see §3. |
| H3 | nginx allowlist scaffolding for Anthropic's `160.79.104.0/21` | Anthropic publishes stable egress ranges and recommends allowlisting; `/authorize` stays open to corporate egress because it runs in the user's browser. Commented out until Stage 6 confirms the real source addresses. |
| H4 | Truncated results publish `totals_partial`; aggregation in integer kg; unmapped enums excluded; negative outstanding preserved | Four distinct paths to a confidently wrong number. |
| H5 | Short TTL cache; pages 2..N fetched concurrently; page size clamped to `maxLimit` | Ten sequential round-trips cannot meet P95 ≤ 5 s. |
| H6 | **Added a 9th tool, `klip_reference`**, plus a typed `UNKNOWN_FILTER_VALUE` | Without it a mistyped plant name returns an empty set that reads as "nothing is outstanding". |
| H7 | `environment` and `source` derived from `KLIP_ENV` | The specified hardcoded "KLIP production" string would have made every staging UAT answer claim to be production. |
| H9 | `audit_events` is monthly **range-partitioned**; added `audit:export`; `X-Forwarded-For` honoured | Retention by partition drop is the only thing the append-only trigger permits; U5's export had no implementation; client IPs would all have logged as 127.0.0.1. |
| H10 | Backup sidecar, container healthcheck, `/healthz` detail restricted to internal callers | Specified in the TSD but never implemented in the guide, so it would not have existed at go-live. |
| — | Unknown tool parameters **rejected** via `z.strictObject` | PRD 8.1 requires rejection; a plain `z.object` silently ignores extras. |
| — | Tools return `structuredContent` against an `outputSchema` | Typed data rather than JSON embedded in prose — fewer transcription errors, which is what M1 measures. |

## 9. Still outstanding

- **Appendix A reconciliation** (P1) — blocks production, enforced at startup.
- **KLIP-side K1–K4** — the `MCP_READONLY` role, `svc-mcp` account, security-group rule.
- **Off-host backup sync and a tested restore** — the sidecar writes locally only.
- **Real corporate egress CIDRs** in `deploy/nginx/mcp.conf`, then enable the two
  commented `return 403` lines.
- **Load test** at the 30-concurrent-user capacity NFR.
- **Hub client registration — the gateway's own, in the testing DWS Hub first**:
  `HUB_ISSUER`, client id and secret, with redirect URI
  `<PUBLIC_URL>/authorize/hub/callback` registered Hub-side. Confirm the Hub's email
  and groups claim names, then run `hub:check`. A second, separate registration in
  the production Hub is needed at Stage 7.
- Decide whether to set `HUB_REQUIRED_GROUP`, and whether to turn
  `BREAK_GLASS_ENABLED=false` after the Hub path is proven in production.

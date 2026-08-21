/**
 * Admin CLI.
 *
 * Run inside the container, which is where node and node_modules live:
 *   docker compose exec -T gateway node dist/cli.js <command>
 *
 * That invocation matters: the runbook's `cd /opt/mcp && node cli.js` cannot work,
 * because the host installs Docker only and never Node (review B6). The kill-switch
 * drill must time the command that actually exists.
 *
 * Commands:
 *   user:add <email> [name]        add a pilot user who signs in via Downstream Hub
 *   user:add-break-glass <email>   provision the single local emergency account
 *   hub:check                      verify Hub OIDC discovery and print the redirect_uri
 *   user:disable <email>           disable and revoke every token they hold
 *   user:enable <email>            re-enable
 *   user:password <email>          set a new password
 *   user:list                      list accounts and their state
 *   client:add <name> <uri,...>    pre-register an OAuth client (manual connector path)
 *   tokens:revoke-all              KILL SWITCH (S8): invalidate every issued token
 *   audit:export --from --to       CSV/JSONL export for IT Security (S4 / U5)
 *   audit:summary [--days N]       per-tool usage, error and truncation rates
 *   routes:verify                  probe KLIP and report the Appendix A gaps
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { cfg } from './core/config.js';
import { closePool, query } from './core/db.js';
import { runMigrations } from './core/migrate.js';
import * as users from './auth/users.js';
import { preRegister } from './auth/clients.js';
import * as hub from './auth/hub.js';
import { revokeAll, revokeUser } from './auth/tokens.js';
import * as audit from './core/audit.js';
import { routes, verificationGaps, type RouteContract } from './adapters/klip/routes.js';
import { authorizedGet } from './adapters/klip/session.js';
import { extractRows, TOTAL_PAGES_ALTERNATES } from './adapters/klip/paginate.js';

const MIN_PASSWORD_LENGTH = 12;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Queue of lines read from a non-TTY stdin.
 *
 * `docker compose exec -T` allocates no TTY - which is exactly how the runbook
 * invokes this CLI - so an interactive-only prompt would never return. When stdin
 * is not a terminal we read plain lines instead, which also makes the commands
 * scriptable.
 */
let pipedLines: string[] | undefined;

async function readPipedLines(): Promise<string[]> {
  if (pipedLines !== undefined) return pipedLines;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return pipedLines;
}

/** Read a secret without echoing it to the terminal. */
async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const lines = await readPipedLines();
    const next = lines.shift();
    if (next === undefined) throw new Error(`expected a value for "${label.trim()}" on stdin`);
    return next;
  }

  const muted = new Writable({
    write(_chunk, _enc, done) {
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(label);
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function promptNewPassword(): Promise<string> {
  const first = await promptSecret('New password: ');
  if (first.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const second = await promptSecret('Confirm password: ');
  if (first !== second) throw new Error('passwords do not match');
  return first;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const PILOT_CAP = 15;

/**
 * Add a pilot user who authenticates through Downstream Hub. No password: the Hub
 * proves who they are, and this entry is the ALLOWLIST that admits them.
 */
async function cmdUserAdd(args: string[]): Promise<void> {
  const email = args[0];
  if (email === undefined) throw new Error('usage: user:add <email> [display name]');
  if (await users.findByEmail(email)) throw new Error(`user already exists: ${email}`);

  const active = await users.countActivePilots();
  if (active >= PILOT_CAP) {
    throw new Error(
      `the pilot cap of ${PILOT_CAP} active users is already reached (PRD Section 16). ` +
        'Disable someone first, or raise the cap deliberately.',
    );
  }

  const user = await users.addHubUser(email, args[1]);
  await audit.write({
    event: 'admin_action',
    ctx: { requestId: audit.newRequestId(), userId: 'cli' },
    outcome: 'pilot_user_added',
    detail: { email: user.email, auth_source: 'hub' },
  });
  out(`added ${user.email} to the pilot list (signs in through Downstream Hub)`);
  out(`${active + 1} of ${PILOT_CAP} pilot places used.`);
  if (!cfg.hubEnabled) {
    out('NOTE: Hub OIDC is not configured yet, so this user cannot sign in until HUB_ISSUER,');
    out('      HUB_CLIENT_ID and HUB_CLIENT_SECRET are set.');
  }
}

/**
 * Provision the single break-glass local account. Only for use when the Hub is
 * down or misconfigured; every sign-in through it is audited at high severity.
 */
async function cmdBreakGlassAdd(args: string[]): Promise<void> {
  const email = args[0];
  if (email === undefined) throw new Error('usage: user:add-break-glass <email> [display name]');
  const password = await promptNewPassword();
  const user = await users.addBreakGlassUser(email, password, args[1]);
  await audit.write({
    event: 'admin_action',
    ctx: { requestId: audit.newRequestId(), userId: 'cli' },
    outcome: 'break_glass_account_provisioned',
    detail: { email: user.email, auth_source: 'local', severity: 'high' },
  });
  out(`provisioned break-glass account ${user.email} (must change password at first use)`);
  out('This is the ONLY account that can sign in without Downstream Hub. Treat the password');
  out('as an emergency credential: store it in the vault, not in a password manager shared by the team.');
}

async function cmdUserDisable(args: string[]): Promise<void> {
  const email = args[0];
  if (email === undefined) throw new Error('usage: user:disable <email>');
  const row = await users.findByEmail(email);
  if (row === undefined) throw new Error(`no such user: ${email}`);
  await users.disable(email);
  await revokeUser(row.id, 'user disabled via CLI');
  await audit.write({
    event: 'token_revoked',
    ctx: { requestId: audit.newRequestId(), userId: 'cli' },
    outcome: 'user_disabled',
    detail: { email: row.email },
  });
  out(`disabled ${row.email} and revoked their tokens`);
}

async function cmdUserEnable(args: string[]): Promise<void> {
  const email = args[0];
  if (email === undefined) throw new Error('usage: user:enable <email>');
  await users.enable(email);
  out(`enabled ${email}`);
}

async function cmdUserPassword(args: string[]): Promise<void> {
  const email = args[0];
  if (email === undefined) throw new Error('usage: user:password <email>');
  if ((await users.findByEmail(email)) === undefined) throw new Error(`no such user: ${email}`);
  const password = await promptNewPassword();
  await users.setPassword(email, password);
  out(`password updated for ${email}`);
}

async function cmdUserList(): Promise<void> {
  const rows = await users.list();
  if (rows.length === 0) {
    out('no users yet - add a pilot user with: user:add <email>');
    return;
  }
  out('EMAIL                                    SIGN-IN      STATE      HUB LINKED');
  for (const r of rows) {
    const state =
      r.disabled_at !== null
        ? 'disabled'
        : r.locked_until !== null && r.locked_until.getTime() > Date.now()
          ? 'locked'
          : 'active';
    const source = r.is_break_glass ? 'break-glass' : r.auth_source;
    out(
      `${r.email.padEnd(40)} ${source.padEnd(12)} ${state.padEnd(10)} ` +
        `${r.hub_subject !== null ? 'yes' : r.auth_source === 'hub' ? 'not yet' : '-'}`,
    );
  }
  const active = await users.countActivePilots();
  out(`\n${active} of ${PILOT_CAP} pilot places used (PRD Section 16).`);
  out(`Hub OIDC: ${cfg.hubEnabled ? `configured (${cfg.HUB_ISSUER ?? ''})` : 'NOT configured'}`);
  out(`Break-glass password path: ${cfg.BREAK_GLASS_ENABLED ? 'enabled' : 'disabled'}`);
}

/** Verify the Hub is reachable and its metadata is coherent, before pilot users try. */
async function cmdHubCheck(): Promise<void> {
  if (!cfg.hubEnabled) {
    out('Hub OIDC is NOT configured. Set HUB_ISSUER, HUB_CLIENT_ID and HUB_CLIENT_SECRET.');
    return;
  }
  // Make the pairing explicit: two Hub instances exist, and the gateway must be
  // registered separately in each, with its own client id.
  const hubLooksNonProduction = /test|testing|staging|stg|uat|dev|sandbox|localhost|127\.0\.0\.1/.test(
    (cfg.HUB_ISSUER ?? '').toLowerCase(),
  );
  out(`pairing:       KLIP ${cfg.KLIP_ENV}  <->  Hub ${hubLooksNonProduction ? 'testing' : 'production'}`);
  if (cfg.KLIP_ENV === 'production' && hubLooksNonProduction) {
    out('  MISMATCH: production data behind a test identity provider. The gateway refuses to boot like this.');
  }
  out('');
  out(`issuer:        ${cfg.HUB_ISSUER ?? ''}`);
  out(`discovery:     ${cfg.hubDiscoveryUrl ?? ''}`);
  out(`client_id:     ${cfg.HUB_CLIENT_ID ?? ''}`);
  out(`client type:   ${cfg.HUB_CLIENT_SECRET === undefined ? 'public (PKCE, no secret)' : 'confidential (secret set)'}`);
  out(`redirect_uri:  ${cfg.hubRedirectUri}   <-- register this with the Hub`);
  out('               (the MCP GATEWAY has its own Hub client; do not reuse KLIP’s)');
  out(`scopes:        ${cfg.HUB_SCOPES}`);
  out(`email claim:   ${cfg.HUB_EMAIL_CLAIM}`);
  out(`group gate:    ${cfg.HUB_REQUIRED_GROUP ?? '(none)'}`);
  out('');
  const result = await hub.probe();
  if (!result.ok) {
    out(`DISCOVERY FAILED: ${result.detail}`);
    return;
  }
  const meta = await hub.metadata();
  out('discovery OK');
  out(`  authorization_endpoint: ${meta.authorization_endpoint}`);
  out(`  token_endpoint:         ${meta.token_endpoint}`);
  out(`  jwks_uri:               ${meta.jwks_uri}`);
  const methods = meta.code_challenge_methods_supported;
  if (methods !== undefined && !methods.includes('S256')) {
    out(`  WARNING: the Hub does not advertise S256 PKCE (advertises: ${methods.join(', ')})`);
  }

  // A wrong token-endpoint auth method presents as "bad credentials", so show which
  // one will be used and where it came from.
  const authMethods = meta.token_endpoint_auth_methods_supported;
  out(`  token auth advertised:  ${authMethods === undefined ? '(not advertised)' : authMethods.join(', ')}`);
  out(
    `  token auth to be used:  ${hub.tokenAuthMethod(meta)}` +
      (cfg.HUB_TOKEN_AUTH_METHOD === undefined ? ' (from discovery)' : ' (HUB_TOKEN_AUTH_METHOD override)'),
  );
  // DWS Hub needs a JSON body and answers unsupported_grant_type to form encoding.
  out(`  token body encoding:    ${cfg.HUB_TOKEN_BODY} (falls back to the other on unsupported_grant_type)`);

  const scopes = cfg.HUB_SCOPES.split(/\s+/).filter(Boolean);
  const advertisedScopes = (meta as unknown as { scopes_supported?: string[] }).scopes_supported;
  if (advertisedScopes !== undefined) {
    const unsupported = scopes.filter((sc) => !advertisedScopes.includes(sc));
    out(`  scopes advertised:      ${advertisedScopes.join(', ')}`);
    if (unsupported.length > 0) {
      out(`  WARNING: requesting scope(s) the Hub does not advertise: ${unsupported.join(', ')}`);
      if (unsupported.includes('groups')) {
        out('           DWS Hub does not issue a groups claim, so HUB_REQUIRED_GROUP cannot work.');
      }
    }
  }
  if (cfg.HUB_REQUIRED_GROUP !== undefined && advertisedScopes?.includes('groups') !== true) {
    out(`  WARNING: HUB_REQUIRED_GROUP=${cfg.HUB_REQUIRED_GROUP} would refuse EVERY user on this Hub.`);
  }
}

async function cmdClientAdd(args: string[]): Promise<void> {
  const name = args[0];
  const uris = args[1];
  if (name === undefined || uris === undefined) {
    throw new Error('usage: client:add "<client name>" <https://redirect,https://redirect2> [--secret]');
  }
  const withSecret = args.includes('--secret');
  const result = await preRegister(name, uris.split(',').map((u) => u.trim()), withSecret);
  out(`client_id:     ${result.clientId}`);
  if (result.clientSecret !== undefined) out(`client_secret: ${result.clientSecret}   <-- shown once, store it now`);
  out('\nEnter these under "Advanced settings" when adding the custom connector.');
}

/** S8 kill switch. */
async function cmdRevokeAll(args: string[]): Promise<void> {
  const reason = flag(args, 'reason') ?? 'kill switch';
  const started = Date.now();
  const result = await revokeAll(reason);
  await audit.write({
    event: 'token_revoked',
    ctx: { requestId: audit.newRequestId(), userId: 'cli' },
    outcome: 'revoke_all',
    detail: { reason, refresh_tokens: result.refreshTokens, severity: 'high' },
  });
  out(`revoked ${result.refreshTokens} refresh token(s) and invalidated every access token issued so far.`);
  out(`took ${Date.now() - started} ms. Now stop the service:  docker compose stop gateway`);
}

interface AuditRow {
  ts: Date;
  request_id: string;
  user_id: string;
  client_ip: string | null;
  event: string;
  tool: string | null;
  params: unknown;
  klip_calls: unknown;
  row_count: number | null;
  latency_ms: number | null;
  outcome: string | null;
  detail: unknown;
}

/** S4 monthly export / U5 review export. */
async function cmdAuditExport(args: string[]): Promise<void> {
  const from = flag(args, 'from');
  const to = flag(args, 'to');
  if (from === undefined || to === undefined) {
    throw new Error('usage: audit:export --from 2026-08-01 --to 2026-09-01 [--format csv|jsonl] [--out FILE]');
  }
  const format = (flag(args, 'format') ?? 'csv').toLowerCase();
  const outPath = flag(args, 'out');
  const started = Date.now();

  const rows = await query<AuditRow>(
    `SELECT ts, request_id, user_id, client_ip, event, tool, params, klip_calls,
            row_count, latency_ms, outcome, detail
       FROM audit_events
      WHERE ts >= $1::timestamptz AND ts < $2::timestamptz
      ORDER BY ts`,
    [from, to],
  );

  const sink = outPath === undefined ? process.stdout : createWriteStream(outPath, { mode: 0o600 });
  const columns: Array<keyof AuditRow> = [
    'ts', 'request_id', 'user_id', 'client_ip', 'event', 'tool',
    'params', 'klip_calls', 'row_count', 'latency_ms', 'outcome', 'detail',
  ];

  if (format === 'jsonl') {
    for (const row of rows) sink.write(`${JSON.stringify(row)}\n`);
  } else {
    sink.write(`${columns.join(',')}\n`);
    for (const row of rows) sink.write(`${columns.map((c) => csvCell(row[c])).join(',')}\n`);
  }
  if (outPath !== undefined) (sink as ReturnType<typeof createWriteStream>).end();

  process.stderr.write(`exported ${rows.length} rows in ${Date.now() - started} ms (U5 target: < 60000 ms)\n`);
}

async function cmdAuditSummary(args: string[]): Promise<void> {
  const days = Number(flag(args, 'days') ?? 7);
  const rows = await query<{ tool: string | null; calls: string; errors: string; truncated: string; p95_ms: number | null }>(
    `SELECT tool,
            count(*)::text AS calls,
            count(*) FILTER (WHERE outcome <> 'OK')::text AS errors,
            count(*) FILTER (WHERE (detail->>'truncated') = 'true')::text AS truncated,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
       FROM audit_events
      WHERE event = 'tool_outcome' AND ts > now() - ($1 || ' days')::INTERVAL
      GROUP BY tool
      ORDER BY count(*) DESC`,
    [String(days)],
  );

  out(`Tool usage over the last ${days} day(s):\n`);
  out('TOOL                          CALLS  ERRORS  TRUNCATED  P95 ms');
  for (const r of rows) {
    out(
      `${(r.tool ?? '(none)').padEnd(28)} ${r.calls.padStart(6)} ${r.errors.padStart(7)} ` +
        `${r.truncated.padStart(10)} ${String(r.p95_ms ?? '-').padStart(7)}`,
    );
  }

  const perUser = await query<{ user_id: string; calls: string }>(
    `SELECT user_id, count(*)::text AS calls
       FROM audit_events
      WHERE event = 'tool_request' AND ts > now() - ($1 || ' days')::INTERVAL
      GROUP BY user_id ORDER BY count(*) DESC LIMIT 20`,
    [String(days)],
  );
  out(`\nActive users: ${perUser.length}  (M3 target: at least 60% of provisioned pilot users weekly)`);
  for (const u of perUser) out(`  ${u.user_id.padEnd(40)} ${u.calls.padStart(6)} calls`);

  const guards = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events
      WHERE event = 'guard_block' AND ts > now() - ($1 || ' days')::INTERVAL`,
    [String(days)],
  );
  out(`\nGUARD_BLOCK events: ${guards[0]?.n ?? '0'}  (M5: must be 0; any occurrence pages the owner)`);
}

/**
 * Probe KLIP staging and report what Appendix A still needs.
 * Turns the blocking manual gate into a repeatable check (review H5).
 */
async function cmdRoutesVerify(): Promise<void> {
  out(`Probing ${cfg.KLIP_BASE_URL} (KLIP_ENV=${cfg.KLIP_ENV})\n`);

  for (const [name, route] of Object.entries(routes as Record<string, RouteContract>)) {
    if (name === 'login' || route.path.includes(':')) {
      out(`${name.padEnd(18)} SKIP  (${route.path} - verify by hand)`);
      continue;
    }
    try {
      const params: Record<string, string | number> = {};
      if (route.params.limit !== undefined) params[route.params.limit] = 1;
      if (route.params.page !== undefined) params[route.params.page] = 1;

      const body = await authorizedGet<unknown>(route.path, params);
      if (body === undefined) {
        out(`${name.padEnd(18)} 404   ${route.path}  <-- path is wrong, fix routes.ts`);
        continue;
      }
      const rows = extractRows<Record<string, unknown>>(body, route.rowsPath);
      const pagesShape = TOTAL_PAGES_ALTERNATES.find((p) => {
        let cursor: unknown = body;
        for (const seg of p.split('.')) {
          if (cursor === null || typeof cursor !== 'object') return false;
          cursor = (cursor as Record<string, unknown>)[seg];
        }
        return typeof cursor === 'number';
      });
      const sampleKeys = rows[0] === undefined ? [] : Object.keys(rows[0]).slice(0, 12);
      out(`${name.padEnd(18)} OK    rows=${rows.length} totalPages@${pagesShape ?? 'NOT FOUND'}`);
      if (sampleKeys.length > 0) out(`${' '.repeat(18)}       fields: ${sampleKeys.join(', ')}`);
    } catch (err) {
      out(`${name.padEnd(18)} FAIL  ${(err as Error).message}`);
    }
  }

  const maxLimitHint =
    'Also determine each endpoint\'s maximum accepted `limit` by hand (try 100, 500, 1000 and compare the row ' +
    'count returned). A silent clamp is what turns one page into ten and breaks the latency target.';
  out(`\n${maxLimitHint}`);

  const gaps = verificationGaps();
  out(`\nAppendix A gaps still open: ${gaps.length}`);
  for (const gap of gaps) out(`  - ${gap.route}: ${gap.reason}`);
  if (gaps.length > 0) {
    out('\nRecord the verified values in src/adapters/klip/routes.ts and src/adapters/klip/fields.ts,');
    out('set verified: true per route and enums.verified = true. Production startup is gated on this.');
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  'user:add': cmdUserAdd,
  'user:add-break-glass': cmdBreakGlassAdd,
  'user:disable': cmdUserDisable,
  'user:enable': cmdUserEnable,
  'user:password': cmdUserPassword,
  'user:list': async () => cmdUserList(),
  'client:add': cmdClientAdd,
  'tokens:revoke-all': cmdRevokeAll,
  'audit:export': cmdAuditExport,
  'audit:summary': cmdAuditSummary,
  'routes:verify': async () => cmdRoutesVerify(),
  'hub:check': async () => cmdHubCheck(),
  migrate: async () => {
    const applied = await runMigrations();
    out(`applied ${applied.length} migration file(s)`);
  },
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === undefined || command === 'help' || command === '--help') {
    out('MCP Gateway admin CLI\n');
    out('  docker compose exec -T gateway node dist/cli.js <command> [args]\n');
    for (const name of Object.keys(COMMANDS)) out(`  ${name}`);
    return;
  }

  const handler = COMMANDS[command];
  if (handler === undefined) throw new Error(`unknown command: ${command} (try "help")`);
  await handler(args);
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: Error) => {
    process.stderr.write(`error: ${err.message}\n`);
    await closePool().catch(() => undefined);
    process.exit(1);
  });

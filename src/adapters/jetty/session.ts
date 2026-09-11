/**
 * JPS service-account session.
 *
 * Mirrors the KLIP session's shape - in-memory token only, one re-login on 401, a
 * second 401 flips to degraded - but is separate code by decision (11 Sep 2026), so the
 * hardened KLIP path is not touched to serve a second upstream.
 *
 * THE LOGIN SHAPE IS NOW MEASURED (11 Sep 2026), not inferred. A real response:
 *
 *   200, body {"user":{"id":"32","username":"MCP",...}}   <- NO token in the body
 *   Set-Cookie: jps_at=<JWT>;   Max-Age=28800; HttpOnly; SameSite=Lax
 *   Set-Cookie: jps_xsrf=<hex>; Max-Age=28800;           SameSite=Lax
 *
 * So the credential is the `jps_at` cookie and nothing else. The body carries only a
 * profile, which is why this file never looks there first any more. `jps_xsrf` is the
 * CSRF double-submit value, NOT a credential - presenting it as a Bearer would fail,
 * and it is excluded explicitly rather than by luck of ordering.
 *
 * TWO CONSEQUENCES THAT SHAPE THIS FILE:
 *
 * 1. THE TOKEN EXPIRES IN 8 HOURS. Max-Age 28800, and the JWT's own exp - iat is the
 *    same 28800. Caching it until a 401 would mean one guaranteed failed call every
 *    eight hours, recovered by a re-login but paid for by whoever asked. The token is
 *    therefore refreshed on `exp` with a margin, and the 401 path stays as the
 *    backstop it should have been all along.
 *
 * 2. LOGIN IS RATE LIMITED: RateLimit-Policy 40;w=900 - forty attempts per fifteen
 *    minutes. At one login per eight hours that is irrelevant; under a login loop it
 *    locks the connector out for a quarter of an hour. That is why concurrent logins
 *    are collapsed through `inFlightLogin` and why a failed login is never retried.
 *
 * The account's `username` is "MCP"; svc-mcp@energi-up.com is its EMAIL, and the login
 * handler takes `username`. Configure JETTY_SVC_USER=MCP.
 */
import { cfg } from './../../core/config.js';
import { logger } from './../../core/logger.js';
import { upstreamAuth, upstreamRouteMissing, capabilityUnavailable } from './../../core/errors.js';
import { Semaphore } from './../../core/semaphore.js';
import { jettyRequest, jettyConfigured, type JettyResponse } from './client.js';

/** Separate from KLIP's semaphore: one upstream must not starve the other. */
export const jettyFetchSemaphore = new Semaphore(cfg.KLIP_FETCH_CONCURRENCY);

interface CachedToken {
  token: string;
  obtainedAt: number;
  /** Epoch ms at which this token stops being usable, from the JWT's own `exp`. */
  expiresAt: number;
}

/** Refresh this far before expiry, so a long call cannot straddle the boundary. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Read `exp` out of a JWT payload without verifying it.
 *
 * Verification is JPS's job - this is our own token, handed to us over the wire we just
 * authenticated on, and the only thing being decided is when to ask for a new one.
 * Returns null on anything unexpected so a malformed token falls back to the fixed
 * lifetime rather than throwing inside the login path.
 */
function readExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

let cached: CachedToken | undefined;
let inFlightLogin: Promise<string> | undefined;
let degraded = false;

export function isJettyDegraded(): boolean {
  return degraded;
}

/** Clears the cached token. Used by rotation and by tests. */
export function resetJettySession(): void {
  cached = undefined;
  inFlightLogin = undefined;
  degraded = false;
}

/**
 * The login body carries a profile, not a token - measured. Kept typed so a future JPS
 * release that DOES return one is picked up rather than ignored.
 */
interface LoginBody {
  user?: { id?: string; username?: string };
  token?: string;
  accessToken?: string;
  data?: { token?: string; accessToken?: string };
}

/** The session cookie JPS actually sets. */
const SESSION_COOKIE = 'jps_at';

/**
 * Take the session JWT from Set-Cookie.
 *
 * `jps_at` by exact name, because that is what JPS sets and a name match is not
 * something to leave to a regex when the wrong cookie is the CSRF token. Any cookie
 * whose name looks like CSRF is refused outright even if it somehow matched first -
 * presenting `jps_xsrf` as a Bearer would fail confusingly rather than loudly.
 *
 * A body token is still accepted as a fallback, so a future JPS release that returns
 * one is used rather than ignored.
 */
function extractToken(
  res: JettyResponse<LoginBody>,
  setCookie: readonly string[],
): { token: string; from: string } | null {
  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    if (pair === undefined) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/xsrf|csrf/i.test(name)) continue;
    if (name !== SESSION_COOKIE) continue;
    if (value.length > 0) return { token: value, from: `cookie:${name}` };
  }

  const body = res.data;
  const fromBody = body?.token ?? body?.accessToken ?? body?.data?.token ?? body?.data?.accessToken;
  if (typeof fromBody === 'string' && fromBody.length > 0) return { token: fromBody, from: 'body' };

  return null;
}

async function login(): Promise<string> {
  if (!jettyConfigured()) {
    throw capabilityUnavailable(
      'Jetty Planning System data',
      'The gateway has no JPS credentials configured. This is a deployment gap, NOT a statement that ' +
        'the data does not exist - check the JPS application directly.',
    );
  }

  const res = await jettyRequest<LoginBody>('POST', '/auth/login', {
    body: { username: cfg.JETTY_SVC_USER, password: cfg.JETTY_SVC_PASS },
    retries: 0,
  });

  if (res.status === 401 || res.status === 403) {
    degraded = true;
    logger.error(
      { status: res.status, user: cfg.JETTY_SVC_USER },
      'JPS rejected the service account - check that JETTY_SVC_USER is the USERNAME, not the email',
    );
    throw upstreamAuth();
  }
  if (res.status === 404) throw upstreamRouteMissing('/auth/login', 404, 'JPS', 'src/adapters/jetty/routes.ts');
  if (res.status >= 400) {
    degraded = true;
    throw upstreamAuth();
  }

  const setCookie = ((res as unknown as { headers?: Record<string, unknown> }).headers?.['set-cookie'] ??
    []) as readonly string[];
  const found = extractToken(res, Array.isArray(setCookie) ? setCookie : [String(setCookie)]);

  if (found === null) {
    degraded = true;
    logger.error(
      { bodyKeys: Object.keys(res.data ?? {}), cookieCount: setCookie.length },
      'JPS login succeeded but no bearer token was found in the body or in Set-Cookie - see the note ' +
        'at the top of adapters/jetty/session.ts',
    );
    throw upstreamAuth();
  }

  const now = Date.now();
  // Fall back to the observed 8-hour lifetime if the token is not a readable JWT.
  const expiresAt = readExpiry(found.token) ?? now + 28_800 * 1000;
  logger.info(
    { from: found.from, expiresInMinutes: Math.round((expiresAt - now) / 60_000) },
    'JPS service-account login succeeded',
  );
  cached = { token: found.token, obtainedAt: now, expiresAt };
  degraded = false;
  return found.token;
}

async function currentToken(): Promise<string> {
  // Refresh BEFORE expiry rather than after a 401. The token lives 8 hours, so caching
  // it until rejection means one guaranteed failed call every 8 hours, paid for by
  // whoever happened to ask.
  if (cached !== undefined && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.token;
  cached = undefined;
  // Collapse concurrent logins: a burst of tool calls on a cold cache must not send a
  // burst of login POSTs at an operational system.
  inFlightLogin ??= login().finally(() => {
    inFlightLogin = undefined;
  });
  return inFlightLogin;
}

export interface JettyCallRecord {
  pathname: string;
  status: number;
  durationMs: number;
}

/**
 * Authorized GET against JPS, with a single re-login on 401.
 *
 * There is no authorizedPost, and there will not be one. See client.ts.
 */
export async function jettyGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  calls?: JettyCallRecord[],
  opts: { portId?: number | undefined; timeoutMs?: number | undefined } = {},
): Promise<T> {
  return jettyFetchSemaphore.run(async () => {
    // Port scope defaults to the configured port. JPS scopes every request, so a
    // figure without one is meaningless - see routes.ts.
    const portId = opts.portId ?? cfg.JETTY_PORT_ID;
    const token = await currentToken();
    const req = {
      params,
      portId,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };

    let res: JettyResponse<T> = await jettyRequest<T>('GET', path, { ...req, bearerToken: token });

    if (res.status === 401) {
      logger.warn({ pathname: res.pathname }, 'JPS returned 401 - re-authenticating once');
      cached = undefined;
      const fresh = await login();
      res = await jettyRequest<T>('GET', path, { ...req, bearerToken: fresh });
      if (res.status === 401) {
        degraded = true;
        logger.error({ pathname: res.pathname }, 'JPS returned 401 after re-login - AUTH_DEGRADED');
        throw upstreamAuth();
      }
    }

    calls?.push({ pathname: res.pathname, status: res.status, durationMs: res.durationMs });

    if (res.status === 404) {
      throw upstreamRouteMissing(res.pathname, 404, 'JPS', 'src/adapters/jetty/routes.ts');
    }
    if (res.status === 403) {
      // Distinct from 401: the account authenticated but lacks the page permission, or
      // the port is not assigned to it. Saying which is not possible from here, but
      // saying that it is a PERMISSION problem rather than an empty result is.
      throw upstreamAuth();
    }

    return res.data;
  });
}

/**
 * Exposed for tests. Both are pure, and both encode a fact measured off a real login
 * response rather than a guess - which is exactly the kind of thing that should be
 * pinned by a test rather than re-derived by the next reader.
 */
export const jettySessionInternals = { extractToken, readExpiry, SESSION_COOKIE, EXPIRY_MARGIN_MS };

/**
 * JPS service-account session.
 *
 * Mirrors the KLIP session's shape - in-memory token only, one re-login on 401, a
 * second 401 flips to degraded - but is separate code by decision (11 Sep 2026), so the
 * hardened KLIP path is not touched to serve a second upstream.
 *
 * ONE THING HERE IS UNVERIFIED, AND IT IS THE IMPORTANT ONE.
 *
 * The JPS Technical Documentation says POST /api/v1/auth/login "sets HTTP-only JWT
 * cookie + XSRF-TOKEN cookie; returns user profile" - it does NOT say the response body
 * carries a bearer token. Separately FR-AUTH-1 says a Bearer token is supported for
 * non-browser clients. Both can be true if the JWT that arrives in Set-Cookie is the
 * same value a non-browser client presents as a Bearer, which is the usual arrangement,
 * but that is an inference and this connector has been burned by inferences.
 *
 * It could not be tested here: verifying it means authenticating, and Claude does not
 * handle passwords. So `login()` accepts BOTH shapes, logs which one it found, and
 * fails with a precise message if neither is present, rather than guessing and
 * reporting a confusing 401 later.
 *
 * To settle it, from the gateway host:
 *   curl -i -sS -X POST http://<jps-host>:3000/api/v1/auth/login \
 *     -H 'Content-Type: application/json' \
 *     -d '{"username":"MCP","password":"<the password>"}'
 * and look at whether a token appears in the JSON body, in Set-Cookie, or both.
 *
 * Note the username: the staging account's `username` is "MCP"; svc-mcp@energi-up.com
 * is its EMAIL. The login handler takes `username`, so the email may not authenticate.
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

/** Both shapes the login response might take. Neither is assumed. */
interface LoginBody {
  token?: string;
  accessToken?: string;
  data?: { token?: string; accessToken?: string };
}

/**
 * Pull a JWT out of whichever place JPS puts it.
 *
 * Order is body first, then Set-Cookie, because a body token is unambiguous while a
 * cookie value has to be parsed out and could in principle be the CSRF token rather
 * than the session. The cookie branch therefore looks only for a session-ish name and
 * explicitly skips XSRF-TOKEN, which is NOT a credential for a Bearer header.
 */
function extractToken(res: JettyResponse<LoginBody>, setCookie: readonly string[]): { token: string; from: string } | null {
  const body = res.data;
  const fromBody = body?.token ?? body?.accessToken ?? body?.data?.token ?? body?.data?.accessToken;
  if (typeof fromBody === 'string' && fromBody.length > 0) return { token: fromBody, from: 'body' };

  for (const raw of setCookie) {
    const [pair] = raw.split(';');
    if (pair === undefined) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/xsrf|csrf/i.test(name)) continue;
    if (!/token|jwt|session|jps/i.test(name)) continue;
    if (value.length > 0) return { token: value, from: `cookie:${name}` };
  }
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

  logger.info({ from: found.from }, 'JPS service-account login succeeded');
  cached = { token: found.token, obtainedAt: Date.now() };
  degraded = false;
  return found.token;
}

async function currentToken(): Promise<string> {
  if (cached !== undefined) return cached.token;
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

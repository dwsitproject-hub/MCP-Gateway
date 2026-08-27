/**
 * Service-account session (TSD Section 7.2).
 *
 *  - Logs in with vault credentials; the JWT is cached IN MEMORY ONLY, never persisted.
 *  - On a 401 from any call: one re-login and one replay.
 *  - A second 401 raises UPSTREAM_AUTH, flips /healthz to degraded, and is audited.
 *  - Credential rotation is a vault edit plus a container restart: no code change.
 */
import { cfg } from './../../core/config.js';
import { logger } from './../../core/logger.js';
import { upstreamAuth, upstreamRouteMissing } from './../../core/errors.js';
import { Semaphore } from './../../core/semaphore.js';
import { klipRequest, type KlipResponse } from './client.js';
import { routes } from './routes.js';

/** Shared across the whole gateway: bounds concurrent upstream fetches (2 vCPU guardrail). */
export const fetchSemaphore = new Semaphore(cfg.KLIP_FETCH_CONCURRENCY);

interface CachedToken {
  token: string;
  obtainedAt: number;
}

let cached: CachedToken | undefined;
let inFlightLogin: Promise<string> | undefined;
let degraded = false;

export function isDegraded(): boolean {
  return degraded;
}

/** Clears the cached token. Used by rotation and by tests. */
export function resetSession(): void {
  cached = undefined;
  inFlightLogin = undefined;
  degraded = false;
}

interface LoginBody {
  token?: string;
  accessToken?: string;
  access_token?: string;
  data?: { token?: string; accessToken?: string; access_token?: string };
}

/** Pull the JWT out of whatever shape KLIP's login returns (confirm in Appendix A). */
function extractToken(body: LoginBody): string | undefined {
  return (
    body.token ??
    body.accessToken ??
    body.access_token ??
    body.data?.token ??
    body.data?.accessToken ??
    body.data?.access_token
  );
}

async function login(): Promise<string> {
  // Collapse concurrent logins into one request.
  if (inFlightLogin !== undefined) return inFlightLogin;

  inFlightLogin = (async () => {
    const res = await klipRequest<LoginBody>('POST', routes.login.path, {
      body: { email: cfg.KLIP_SVC_USER, username: cfg.KLIP_SVC_USER, password: cfg.KLIP_SVC_PASS },
    });

    if (res.status === 401 || res.status === 403) {
      degraded = true;
      logger.error({ status: res.status }, 'KLIP rejected the service-account credentials');
      throw upstreamAuth();
    }
    // 404/405 mean the path is wrong, not the password. Distinguishing them matters:
    // one is a one-line fix in routes.ts, the other is a conversation with the KLIP team.
    if (res.status === 404 || res.status === 405) {
      degraded = true;
      logger.error(
        { status: res.status, path: routes.login.path, baseUrl: cfg.KLIP_BASE_URL },
        'KLIP login path not found - the route map is wrong, credentials were never checked',
      );
      throw upstreamRouteMissing(routes.login.path, res.status);
    }
    if (res.status >= 400) {
      degraded = true;
      logger.error({ status: res.status }, 'KLIP login returned an unexpected status');
      throw upstreamAuth();
    }

    const token = extractToken(res.data ?? {});
    if (token === undefined || token === '') {
      degraded = true;
      logger.error('KLIP login succeeded but no token field was recognised - check Appendix A login contract');
      throw upstreamAuth();
    }

    cached = { token, obtainedAt: Date.now() };
    degraded = false;
    logger.info('service-account session established');
    return token;
  })().finally(() => {
    inFlightLogin = undefined;
  });

  return inFlightLogin;
}

async function currentToken(): Promise<string> {
  if (cached !== undefined) return cached.token;
  return login();
}

export interface CallRecord {
  pathname: string;
  status: number;
  durationMs: number;
}

/**
 * Authorized GET against KLIP, with the single re-login on 401.
 * Every call passes through the shared fetch semaphore.
 */
export async function authorizedGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  calls?: CallRecord[],
): Promise<T> {
  return fetchSemaphore.run(async () => {
    const token = await currentToken();
    let res: KlipResponse<T> = await klipRequest<T>('GET', path, { params, bearerToken: token });

    if (res.status === 401) {
      logger.warn({ pathname: res.pathname }, 'KLIP returned 401 - re-authenticating once');
      cached = undefined;
      const fresh = await login();
      res = await klipRequest<T>('GET', path, { params, bearerToken: fresh });
      if (res.status === 401) {
        degraded = true;
        logger.error({ pathname: res.pathname }, 'KLIP returned 401 after re-login - AUTH_DEGRADED');
        throw upstreamAuth();
      }
    }

    calls?.push({ pathname: res.pathname, status: res.status, durationMs: res.durationMs });

    if (res.status === 403) {
      /**
       * A role denying a read it should permit.
       *
       * The TSD names the intended role MCP_READONLY. The account actually provisioned
       * carries role=MANAGEMENT, level=Admin, which reads as over-privileged from its
       * name and is view-only in fact - confirmed by IT on 27 Aug 2026. So a 403 here is
       * a grant problem on whatever role svc-mcp really holds, not evidence that the
       * account was mis-scoped. Logging the name it reports avoids sending whoever
       * debugs this looking for a role that does not exist on it.
       */
      degraded = true;
      logger.error(
        { pathname: res.pathname },
        'KLIP returned 403 on a GET - check the grants on the svc-mcp role as provisioned (K1)',
      );
      throw upstreamAuth();
    }
    if (res.status === 404) {
      // Let the caller decide whether a 404 means NOT_FOUND or a wrong route contract.
      return undefined as unknown as T;
    }
    if (res.status >= 400) {
      logger.error({ pathname: res.pathname, status: res.status }, 'unexpected KLIP status');
      throw upstreamAuth();
    }

    return res.data;
  });
}

/** Lightweight probe for /healthz. Does not throw. */
export async function probe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const params: Record<string, string | number> = {};
    const limitParam = routes.contracts.params.limit;
    if (limitParam !== undefined) params[limitParam] = 1;
    await authorizedGet<unknown>(routes.contracts.path, params);
    return { ok: true, detail: 'up' };
  } catch (err) {
    return { ok: false, detail: degraded ? 'auth_degraded' : (err as Error).message };
  }
}

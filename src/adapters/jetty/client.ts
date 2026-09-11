/**
 * JPS HTTP client — separate from the KLIP client by decision, 11 Sep 2026.
 *
 * The alternative was a shared factory taking a base URL. Jerry chose separation, and
 * it is the safer call: the KLIP client is the hardened path for a connector already in
 * use, and refactoring it to serve a second upstream would put that at risk for the
 * benefit of avoiding some duplication. The duplication is real and deliberate.
 *
 * THE GUARD IS THE POINT. JPS is the operational system of record: its API approves
 * shipment plans, signs off operations and records the cast-off that marks a vessel
 * SAILED. The staging service account holds `JPS Full Access` - 28 of 31 pages with
 * edit and delete, 29 with approve - so nothing upstream will stop a write. This file
 * is the thing that does.
 *
 * Layers, mirroring the KLIP design:
 *   (a) no write tool exists in the registry
 *   (b) THIS FILE - the client can physically emit only GET, plus one login POST
 *   (c) [ABSENT ON STAGING] a read-only role server-side. Its absence is exactly why
 *       (b) is written as a guard rather than a convention, and it is logged as a
 *       Stage 7 blocker in the runbook.
 *
 * The guard runs on the RESOLVED URL pathname, never the caller's relative string, so
 * traversal ("../../admin") and absolute-URL injection cannot slip past it.
 */
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { cfg } from './../../core/config.js';
import { GuardError, upstreamUnavailable, capabilityUnavailable } from './../../core/errors.js';
import { logger } from './../../core/logger.js';

export type JettyMethod = 'GET' | 'POST';

/** The single POST the guard permits: the service-account login. */
const LOGIN_PATH = '/auth/login';

/**
 * Resolved lazily rather than at import time.
 *
 * JETTY_* config is optional so a gateway with no JPS configured boots unchanged. If
 * this module resolved its base URL at import, an unconfigured gateway would crash on
 * startup instead of simply not offering jetty tools.
 */
interface Target {
  base: URL;
  basePath: string;
  loginPathname: string;
}

let target: Target | undefined;

export function jettyConfigured(): boolean {
  return (
    cfg.JETTY_BASE_URL !== undefined &&
    cfg.JETTY_SVC_USER !== undefined &&
    cfg.JETTY_SVC_PASS !== undefined
  );
}

function resolveBase(): Target {
  if (target !== undefined) return target;
  if (cfg.JETTY_BASE_URL === undefined) {
    throw capabilityUnavailable(
      'Jetty Planning System data',
      'The gateway has no JPS connection configured (JETTY_BASE_URL is unset). This is a deployment ' +
        'gap, NOT a statement that the data does not exist - check the JPS application directly.',
    );
  }
  const base = new URL(cfg.JETTY_BASE_URL);
  const basePath = base.pathname.replace(/\/+$/, '');
  target = { base, basePath, loginPathname: `${basePath}${LOGIN_PATH}` };
  return target;
}

export interface ResolvedTarget {
  url: string;
  pathname: string;
}

/**
 * Resolve a relative JPS path and assert it stays inside the API mount point.
 *
 * GET may reach any real resource under the mount. POST may reach the login path and
 * nothing else. Every other method is refused outright - there is no DELETE or PATCH
 * branch to fall through, which is what makes "read-only" structural rather than a
 * promise.
 */
export function resolveTarget(method: JettyMethod, path: string): ResolvedTarget {
  const { base, basePath, loginPathname } = resolveBase();

  if (!path.startsWith('/')) throw new GuardError(method, path);
  if (path.includes('..') || path.includes('\\') || /%2e%2e/i.test(path)) throw new GuardError(method, path);
  // "//host/x" is a protocol-relative URL; reject explicitly rather than relying on a
  // non-empty basePath to make it harmless by accident.
  if (path.startsWith('//')) throw new GuardError(method, path);

  let resolved: URL;
  try {
    resolved = new URL(`${basePath}${path}`, base.origin);
  } catch {
    throw new GuardError(method, path);
  }

  // A caller-supplied path must not be able to change host or scheme.
  if (resolved.origin !== base.origin) throw new GuardError(method, path);

  const pathname = resolved.pathname;

  if (method === 'GET') {
    if (!pathname.startsWith(`${basePath}/`)) throw new GuardError(method, path);
    const rest = pathname.slice(basePath.length + 1);
    if (rest === '' || rest.split('/').some((segment) => segment === '')) throw new GuardError(method, path);
  } else if (method === 'POST') {
    if (pathname !== loginPathname) throw new GuardError(method, path);
  } else {
    throw new GuardError(method as string, path);
  }

  return { url: resolved.toString(), pathname };
}

const http: AxiosInstance = axios.create({
  timeout: cfg.JETTY_TIMEOUT_MS,
  // Never follow redirects: a 302 could move the request off the private network.
  maxRedirects: 0,
  validateStatus: undefined,
  headers: { Accept: 'application/json', 'User-Agent': 'energiup-mcp-gateway' },
  // Read the body ourselves so an enormous upstream response cannot exhaust memory.
  maxContentLength: 64 * 1024 * 1024,
  transitional: { clarifyTimeoutError: true },
} as never);

export interface JettyRequestOptions {
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  bearerToken?: string | undefined;
  /**
   * Port scope. JPS resolves x-port-id against the caller's assignments and rejects
   * cross-port references inside the handlers too, so this is not cosmetic.
   *
   * Whether it is ENFORCED is unverified: staging has one port and single-port
   * accounts, so omitting it changed nothing - indistinguishable from a correct
   * default. Sent anyway; re-test when a second port exists.
   */
  portId?: number | undefined;
  /** GETs retry on timeout and 5xx; the login POST never does. */
  retries?: number;
  timeoutMs?: number;
}

export interface JettyResponse<T = unknown> {
  status: number;
  data: T;
  durationMs: number;
  pathname: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Issue a request to JPS. GET, or the login POST — the guard permits nothing else.
 */
export async function jettyRequest<T = unknown>(
  method: JettyMethod,
  path: string,
  opts: JettyRequestOptions = {},
): Promise<JettyResponse<T>> {
  const resolved = resolveTarget(method, path);
  const maxAttempts = method === 'GET' ? 1 + (opts.retries ?? 2) : 1;

  const headers: Record<string, string> = {};
  if (opts.bearerToken !== undefined) headers.Authorization = `Bearer ${opts.bearerToken}`;
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (opts.portId !== undefined) headers['x-port-id'] = String(opts.portId);

  const cleanParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null && v !== '') cleanParams[k] = String(v);
  }

  let lastError = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    try {
      const res: AxiosResponse<T> = await http.request<T>({
        method,
        url: resolved.url,
        params: cleanParams,
        ...(method === 'POST' ? { data: opts.body } : {}),
        headers,
        validateStatus: () => true,
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      } as never);

      const durationMs = Date.now() - started;

      if (res.status >= 500) {
        lastError = `upstream ${res.status}`;
        if (attempt < maxAttempts) {
          await sleep(200 * attempt + Math.floor(Math.random() * 150));
          continue;
        }
        throw upstreamUnavailable(lastError);
      }

      return { status: res.status, data: res.data, durationMs, pathname: resolved.pathname };
    } catch (err) {
      if (err instanceof GuardError) throw err;
      const asError = err as { code?: string; message?: string };
      // upstreamUnavailable thrown above rethrows unchanged on the final attempt.
      if (typeof asError.message === 'string' && asError.message.startsWith('The Jetty')) throw err;

      lastError =
        asError.code === 'ETIMEDOUT' || asError.code === 'ECONNABORTED'
          ? 'timeout'
          : (asError.code ?? 'network error');
      logger.warn(
        { attempt, maxAttempts, reason: lastError, pathname: resolved.pathname },
        'JPS request failed',
      );
      if (attempt < maxAttempts) {
        await sleep(200 * attempt + Math.floor(Math.random() * 150));
        continue;
      }
      throw upstreamUnavailable(lastError);
    }
  }
  throw upstreamUnavailable(lastError);
}

/** Exposed for tests: the one path the guard permits as a POST. */
export const jettyGuardInternals = { LOGIN_PATH, resolveBase };

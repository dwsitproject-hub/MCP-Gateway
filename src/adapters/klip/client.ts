/**
 * KLIP HTTP client with the method/path guard (T-6).
 *
 * This is layer (b) of the PRD's S1 defense in depth:
 *   (a) no write tool exists in the registry
 *   (b) THIS FILE - the client physically cannot emit a write
 *   (c) KLIP's MCP_READONLY role rejects writes server-side
 *
 * The only non-GET request this client can ever produce is the service-account
 * login. Anything else raises GuardError, which is audited at high severity
 * because it means either a coding defect or tampering.
 *
 * The guard runs on the RESOLVED URL pathname, not on the caller's relative
 * string, so traversal ("../admin") and absolute-URL injection cannot slip past it.
 */
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { cfg } from './../../core/config.js';
import { GuardError, upstreamUnavailable } from './../../core/errors.js';
import { logger } from './../../core/logger.js';
import { routes } from './routes.js';

export type HttpMethod = 'GET' | 'POST';

const base = new URL(cfg.KLIP_BASE_URL);
/** e.g. "/api" - the mount point of the KLIP API under its origin. */
const BASE_PATH = base.pathname.replace(/\/+$/, '');
const LOGIN_PATHNAME = `${BASE_PATH}${routes.login.path}`;

const http: AxiosInstance = axios.create({
  timeout: cfg.KLIP_TIMEOUT_MS,
  // Never follow redirects: a 302 could move the request off the private network.
  maxRedirects: 0,
  validateStatus: undefined,
  headers: { Accept: 'application/json', 'User-Agent': 'energiup-mcp-gateway' },
  // Read the body ourselves so an enormous upstream response cannot exhaust memory.
  maxContentLength: 64 * 1024 * 1024,
  transitional: { clarifyTimeoutError: true },
} as never);

export interface ResolvedTarget {
  url: string;
  pathname: string;
}

/**
 * Resolve a relative KLIP path against the configured base and assert it stays
 * inside the API mount point.
 */
export function resolveTarget(method: HttpMethod, path: string): ResolvedTarget {
  if (!path.startsWith('/')) throw new GuardError(method, path);
  if (path.includes('..') || path.includes('\\') || /%2e%2e/i.test(path)) throw new GuardError(method, path);
  // "//host/x" is a protocol-relative URL. It happens to stay on-origin only
  // because BASE_PATH is non-empty; reject it explicitly so the guard does not
  // depend on that accident.
  if (path.startsWith('//')) throw new GuardError(method, path);

  let resolved: URL;
  try {
    resolved = new URL(`${BASE_PATH}${path}`, base.origin);
  } catch {
    throw new GuardError(method, path);
  }

  // A caller-supplied path must not be able to change host or scheme.
  if (resolved.origin !== base.origin) throw new GuardError(method, path);

  const pathname = resolved.pathname;

  if (method === 'GET') {
    // Must land on a real resource inside the mount point: at least one non-empty
    // segment after "/api/", and no empty segments anywhere.
    if (!pathname.startsWith(`${BASE_PATH}/`)) throw new GuardError(method, path);
    const rest = pathname.slice(BASE_PATH.length + 1);
    if (rest === '' || rest.split('/').some((segment) => segment === '')) throw new GuardError(method, path);
  } else if (method === 'POST') {
    if (pathname !== LOGIN_PATHNAME) throw new GuardError(method, path);
  } else {
    throw new GuardError(method as string, path);
  }

  return { url: resolved.toString(), pathname };
}

export interface KlipRequestOptions {
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  bearerToken?: string | undefined;
  /** GET requests retry; the login POST never does. */
  retries?: number;
}

export interface KlipResponse<T = unknown> {
  status: number;
  data: T;
  /** Wall time for this single HTTP call, for the audit record. */
  durationMs: number;
  /** Path only - never the query string, which may carry filter values. */
  pathname: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Perform one guarded request against KLIP.
 * Retries apply to GET only, with jitter, and only for timeouts / 5xx.
 */
export async function klipRequest<T = unknown>(
  method: HttpMethod,
  path: string,
  opts: KlipRequestOptions = {},
): Promise<KlipResponse<T>> {
  const target = resolveTarget(method, path);
  const maxAttempts = method === 'GET' ? 1 + (opts.retries ?? 2) : 1;

  const headers: Record<string, string> = {};
  if (opts.bearerToken !== undefined) headers.Authorization = `Bearer ${opts.bearerToken}`;
  if (method === 'POST') headers['Content-Type'] = 'application/json';

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
        url: target.url,
        params: cleanParams,
        ...(method === 'POST' ? { data: opts.body } : {}),
        headers,
        validateStatus: () => true,
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

      return { status: res.status, data: res.data, durationMs, pathname: target.pathname };
    } catch (err) {
      if (err instanceof GuardError) throw err;
      const asError = err as { code?: string; message?: string };
      // upstreamUnavailable thrown above rethrows unchanged on the final attempt.
      if (typeof asError.message === 'string' && asError.message.startsWith('The KLIP data source')) throw err;

      lastError = asError.code === 'ETIMEDOUT' || asError.code === 'ECONNABORTED' ? 'timeout' : (asError.code ?? 'network error');
      logger.warn({ attempt, maxAttempts, reason: lastError, pathname: target.pathname }, 'KLIP request failed');
      if (attempt < maxAttempts) {
        await sleep(200 * attempt + Math.floor(Math.random() * 150));
        continue;
      }
      throw upstreamUnavailable(lastError);
    }
  }
  throw upstreamUnavailable(lastError);
}

/** Exposed for tests: the login path the guard permits as the sole POST. */
export const guardInternals = { BASE_PATH, LOGIN_PATHNAME };

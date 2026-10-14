/**
 * DWS Hub data API client - GET only, by construction.
 *
 * Reads Sentinel's production-support results (analyses, health reports, bug reports,
 * error groups) from the Hub's read-only service API (`/api/service/v1`). This is NOT the
 * Hub OIDC login in auth/hub.ts: a different credential, a different purpose.
 *
 * Read-only twice over, as for KLIP and JPS:
 *   1. The Hub accepts the service key only on fixed GET routes and answers 405 to any
 *      other method before checking the key.
 *   2. This client has no way to send anything but GET: there is no method parameter,
 *      no body, and every path is checked to stay inside the configured API root.
 *
 * Authentication is a static bearer service key (`hubsvc_...`). No login, no session,
 * no cookie - so unlike JPS there is nothing to refresh, and a 401 means the key was
 * revoked or mistyped.
 */
import axios, { type AxiosInstance } from 'axios';
import { cfg } from './../../core/config.js';
import { GatewayError, GuardError, capabilityUnavailable } from './../../core/errors.js';
import { logger } from './../../core/logger.js';
import { Semaphore } from './../../core/semaphore.js';

interface Target {
  base: URL;
  basePath: string;
}

export interface DwsHubCallRecord {
  pathname: string;
  status: number;
  durationMs: number;
}

let target: Target | undefined;

export function dwshubConfigured(): boolean {
  return cfg.DWSHUB_BASE_URL !== undefined && cfg.DWSHUB_SERVICE_KEY !== undefined;
}

function resolveBase(): Target {
  if (target !== undefined) return target;
  if (cfg.DWSHUB_BASE_URL === undefined || cfg.DWSHUB_SERVICE_KEY === undefined) {
    throw capabilityUnavailable(
      'DWS Hub production-support data',
      'The gateway has no DWS Hub data connection configured (DWSHUB_BASE_URL / DWSHUB_SERVICE_KEY unset). ' +
        'That is a deployment gap, not a statement that the applications are healthy.',
    );
  }
  const base = new URL(cfg.DWSHUB_BASE_URL);
  target = { base, basePath: base.pathname.replace(/\/+$/, '') };
  return target;
}

/**
 * The guard. `path` is relative to the API root and must stay inside it after URL
 * resolution: no traversal, no encoded dots, no backslashes, no scheme-relative hosts,
 * no empty segments.
 */
export function resolveTarget(path: string): { url: string; pathname: string } {
  const { base, basePath } = resolveBase();
  if (!path.startsWith('/') || path.startsWith('//')) throw new GuardError('GET', path);
  if (path.includes('..') || path.includes('\\') || /%2e/i.test(path) || /%2f/i.test(path)) throw new GuardError('GET', path);
  let resolved: URL;
  try {
    resolved = new URL(`${basePath}${path}`, base.origin);
  } catch {
    throw new GuardError('GET', path);
  }
  if (resolved.origin !== base.origin) throw new GuardError('GET', path);
  const pathname = resolved.pathname;
  if (!pathname.startsWith(`${basePath}/`)) throw new GuardError('GET', path);
  const rest = pathname.slice(basePath.length + 1);
  if (rest === '' || rest.split('/').some((segment) => segment === '')) throw new GuardError('GET', path);
  return { url: resolved.toString(), pathname };
}

const http: AxiosInstance = axios.create({
  timeout: cfg.DWSHUB_TIMEOUT_MS,
  maxRedirects: 0,
  maxContentLength: 16 * 1024 * 1024,
  // Every status is handled below; axios must not throw on 4xx.
  validateStatus: () => true,
  headers: { Accept: 'application/json', 'User-Agent': 'energiup-mcp-gateway' },
});

export const dwshubSemaphore = new Semaphore(cfg.KLIP_FETCH_CONCURRENCY);

const hubError = (code: 'UPSTREAM_AUTH' | 'UPSTREAM_UNAVAILABLE', message: string, retryable: boolean): GatewayError =>
  new GatewayError(code, message, { retryable });

/** GET one route. Retries network errors and 5xx twice; never retries 4xx. */
export async function dwshubGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  calls?: DwsHubCallRecord[],
): Promise<T> {
  const { url, pathname } = resolveTarget(path);
  const query: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') query[k] = v;

  return dwshubSemaphore.run(async () => {
    let lastError = 'no response';
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = Date.now();
      try {
        const res = await http.get<T>(url, {
          params: query,
          headers: { Authorization: `Bearer ${cfg.DWSHUB_SERVICE_KEY ?? ''}` },
        });
        const durationMs = Date.now() - t0;
        calls?.push({ pathname, status: res.status, durationMs });
        if (res.status >= 200 && res.status < 300) return res.data;
        if (res.status === 401 || res.status === 403) {
          logger.error({ pathname, status: res.status }, 'DWS Hub rejected the service key');
          throw hubError('UPSTREAM_AUTH', 'The DWS Hub rejected the gateway\'s service key. An administrator needs to check DWSHUB_SERVICE_KEY against the Hub\'s HUB_SERVICE_READ_KEYS.', false);
        }
        if (res.status === 404) {
          throw hubError('UPSTREAM_UNAVAILABLE', 'The DWS Hub service API is not available at the configured address (404) - it may be switched off on the Hub, or DWSHUB_BASE_URL is wrong.', false);
        }
        if (res.status === 400) {
          const msg = typeof (res.data as { error?: unknown })?.error === 'string' ? (res.data as { error: string }).error : 'bad request';
          throw new GatewayError('INVALID_PARAMS', `The DWS Hub refused the filter: ${msg}`);
        }
        if (res.status === 429) {
          throw hubError('UPSTREAM_UNAVAILABLE', 'The DWS Hub is rate-limiting the gateway. Try again in a minute.', true);
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        if (err instanceof GatewayError) throw err;
        lastError = (err as Error).message;
        calls?.push({ pathname, status: 0, durationMs: Date.now() - t0 });
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1) + Math.floor(Math.random() * 100)));
    }
    throw hubError('UPSTREAM_UNAVAILABLE', `The DWS Hub data source is not responding (${lastError}). Try again shortly.`, true);
  });
}

export const dwshubInternals = { resolveBase, reset: (): void => { target = undefined; } };

/**
 * DWS Hub CONTROL client - the gateway's only write to the Hub, by construction.
 *
 * It can do exactly one thing: set which Claude model the Hub's Sentinel uses
 * (PUT /sentinel/model on the Hub's control API, routes/serviceControl.js). Milo calls it
 * through dwshub_set_sentinel_model when the Boss changes Sentinel's model on Milo's Agent
 * team page, so the Hub's Sentinel follows Milo.
 *
 * Separate from the read client (client.ts) on purpose:
 *   - its own credential: a control key (`hubctl_...`, DWSHUB_CONTROL_KEY). The read key is
 *     never sent here and the control key is never sent to the read API;
 *   - no path or method parameter: the one URL and the one method are fixed below;
 *   - the Hub validates the model against its own list and answers 400 with that list, so
 *     the list of allowed models lives in one place (the Hub).
 */
import axios from 'axios';
import { cfg } from './../../core/config.js';
import { GatewayError, capabilityUnavailable } from './../../core/errors.js';
import { logger } from './../../core/logger.js';
import type { DwsHubCallRecord } from './client.js';

const SERVICE_SUFFIX = /\/api\/service\/v1\/?$/;

/** The control API root: DWSHUB_CONTROL_URL, else derived from DWSHUB_BASE_URL. */
export function controlRoot(): string | undefined {
  if (cfg.DWSHUB_CONTROL_URL !== undefined) return cfg.DWSHUB_CONTROL_URL.replace(/\/+$/, '');
  if (cfg.DWSHUB_BASE_URL !== undefined && SERVICE_SUFFIX.test(cfg.DWSHUB_BASE_URL)) {
    return cfg.DWSHUB_BASE_URL.replace(SERVICE_SUFFIX, '/api/service/control/v1');
  }
  return undefined;
}

export function dwshubControlConfigured(): boolean {
  return cfg.DWSHUB_CONTROL_KEY !== undefined && controlRoot() !== undefined;
}

export interface SentinelModelResult {
  model: string;
  previous: string;
  changed: boolean;
  source: string | null;
  updated_at: string | null;
  allowed: Array<{ id: string; label: string }>;
}

const http = axios.create({
  timeout: cfg.DWSHUB_TIMEOUT_MS,
  maxRedirects: 0,
  maxContentLength: 1024 * 1024,
  validateStatus: () => true,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'energiup-mcp-gateway' },
});

const errorText = (data: unknown): string =>
  typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : 'bad request';

/**
 * Set Sentinel's model on the Hub. Idempotent (the same model twice is a no-op on the Hub),
 * so network errors and 5xx are retried twice.
 */
export async function setSentinelModel(model: string, requestedBy: string, calls?: DwsHubCallRecord[]): Promise<SentinelModelResult> {
  const root = controlRoot();
  if (cfg.DWSHUB_CONTROL_KEY === undefined || root === undefined) {
    throw capabilityUnavailable(
      'DWS Hub Sentinel model control',
      'The gateway has no DWS Hub control connection configured (DWSHUB_CONTROL_KEY unset, or no control URL).',
    );
  }
  const url = `${root}/sentinel/model`;
  const pathname = new URL(url).pathname;
  let lastError = 'no response';
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    try {
      const res = await http.put<SentinelModelResult>(url, { model, requested_by: requestedBy }, {
        headers: { Authorization: `Bearer ${cfg.DWSHUB_CONTROL_KEY}` },
      });
      calls?.push({ pathname, status: res.status, durationMs: Date.now() - t0 });
      if (res.status >= 200 && res.status < 300) return res.data;
      if (res.status === 400) {
        const allowed = (res.data as { allowed?: Array<{ id: string }> })?.allowed?.map((m) => m.id).join(', ');
        throw new GatewayError('INVALID_PARAMS', `The DWS Hub refused the model: ${errorText(res.data)}${allowed ? ` Allowed: ${allowed}.` : ''}`);
      }
      if (res.status === 401 || res.status === 403) {
        logger.error({ pathname, status: res.status }, 'DWS Hub rejected the control key');
        throw new GatewayError('UPSTREAM_AUTH', 'The DWS Hub rejected the gateway\'s control key. Check DWSHUB_CONTROL_KEY against the Hub\'s HUB_SERVICE_CONTROL_KEYS.', { retryable: false });
      }
      if (res.status === 404) {
        throw new GatewayError('UPSTREAM_UNAVAILABLE', 'The DWS Hub control API is not available (404): it is off on the Hub (HUB_SERVICE_CONTROL_KEYS unset) or the control URL is wrong.', { retryable: false });
      }
      if (res.status === 429) {
        throw new GatewayError('UPSTREAM_UNAVAILABLE', 'The DWS Hub is rate-limiting the gateway. Try again in a minute.', { retryable: true });
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      lastError = (err as Error).message;
      calls?.push({ pathname, status: 0, durationMs: Date.now() - t0 });
    }
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  throw new GatewayError('UPSTREAM_UNAVAILABLE', `The DWS Hub control API is not responding (${lastError}). Try again shortly.`, { retryable: true });
}

/**
 * Health endpoint (PRD Section 12 Observability, TSD Section 12.4).
 *
 * Composite: OAuth store reachable, KLIP reachable, audit writer not backed up.
 *
 * Review fix H10: the detailed body is only served to loopback and configured
 * admin networks. Publicly it returns a bare 200/503 - "klip: degraded" is
 * internal state and should not be readable by anyone who can reach port 443.
 */
import { Router, type Request, type Response } from 'express';
import * as auditStore from './../core/audit.js';
import { isReachable } from './../core/db.js';
import { probe, isDegraded, fetchSemaphore } from './../adapters/klip/session.js';
import * as hub from './../auth/hub.js';
import { verificationGaps } from './../adapters/klip/routes.js';
import { cfg } from './../core/config.js';
import * as cache from './../core/cache.js';
import { clientIpOf } from './clientIp.js';

/**
 * RFC1918 / loopback, decided by PARSING rather than by string prefix.
 *
 * The first version listed prefixes, and '172.2' and '172.3' were meant as shorthand
 * for 172.20-172.31. They also match 172.2.x.x, 172.32.x.x and 172.200.x.x, every one
 * of them PUBLIC address space - so the detailed health payload, which names the
 * environment, the upstream state and whether the break-glass password path is live,
 * would render for callers this was written to exclude. 172.16.0.0/12 means the second
 * octet is 16 to 31 and nothing else, which a prefix string cannot express.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (addr === '::1') return true;
  const octets = addr.split('.');
  if (octets.length !== 4) return false;
  const parts = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : -1));
  if (parts.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isInternal(req: Request): boolean {
  const ip = clientIpOf(req);
  if (ip === undefined) return false;
  return isPrivateAddress(ip);
}

let lastHubProbe: { at: number; ok: boolean; detail: string } | undefined;

async function hubHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.hubEnabled) return { ok: true, detail: 'not_configured' };
  const now = Date.now();
  if (lastHubProbe !== undefined && now - lastHubProbe.at < PROBE_TTL_MS) {
    return { ok: lastHubProbe.ok, detail: lastHubProbe.detail };
  }
  const result = await hub.probe();
  lastHubProbe = { at: now, ok: result.ok, detail: result.detail };
  return result;
}

/** Cheap probe cache so a health checker cannot generate KLIP load. */
let lastProbe: { at: number; ok: boolean; detail: string } | undefined;
const PROBE_TTL_MS = 15_000;

async function klipHealth(): Promise<{ ok: boolean; detail: string }> {
  const now = Date.now();
  if (lastProbe !== undefined && now - lastProbe.at < PROBE_TTL_MS) {
    return { ok: lastProbe.ok, detail: lastProbe.detail };
  }
  const result = await probe();
  lastProbe = { at: now, ok: result.ok, detail: result.detail };
  return result;
}

export function healthRouter(): Router {
  const router = Router();

  router.get('/healthz', async (req: Request, res: Response) => {
    const [dbOk, klip, hubStatus] = await Promise.all([isReachable(), klipHealth(), hubHealth()]);
    const auditOk = auditStore.isHealthy();
    // The Hub only affects readiness when it is the configured login path. A Hub
    // outage stops NEW authorizations but does not break live tokens, so it is
    // reported without failing the probe and restart-looping the container.
    const ok = dbOk && klip.ok && auditOk;

    res.setHeader('Cache-Control', 'no-store');

    if (!isInternal(req)) {
      // Public: liveness only.
      res.status(ok ? 200 : 503).json({ ok });
      return;
    }

    res.status(ok ? 200 : 503).json({
      ok,
      environment: cfg.KLIP_ENV,
      node_env: cfg.NODE_ENV,
      oauth_store: dbOk ? 'up' : 'down',
      klip: klip.ok ? 'up' : klip.detail,
      klip_auth: isDegraded() ? 'degraded' : 'ok',
      audit_writer: auditOk ? 'ok' : `backlogged (${auditStore.queueDepth()} rows queued)`,
      hub_oidc: cfg.hubEnabled ? (hubStatus.ok ? 'up' : `unreachable: ${hubStatus.detail}`) : 'not_configured',
      break_glass: cfg.BREAK_GLASS_ENABLED ? 'enabled' : 'disabled',
      fetch_slots: { free: fetchSemaphore.free, waiting: fetchSemaphore.pending },
      cache_entries: cache.size(),
      route_map_gaps: verificationGaps().length,
    });
  });

  // Liveness only: no upstream calls, safe for a container healthcheck.
  router.get('/livez', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  });

  return router;
}

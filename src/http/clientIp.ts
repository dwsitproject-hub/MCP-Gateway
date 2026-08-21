/**
 * Real client address behind the nginx loopback proxy (review H9.3).
 *
 * Without this every audit row records 127.0.0.1, which makes the audit log
 * useless for the one question it exists to answer. The app must be configured
 * with `trust proxy = loopback` so express only honours X-Forwarded-For from the
 * local reverse proxy and never from an arbitrary caller.
 */
import type { Request } from 'express';

export function clientIpOf(req: Request): string | undefined {
  // express resolves req.ip from X-Forwarded-For only for trusted proxies.
  const ip = req.ip ?? req.socket.remoteAddress ?? undefined;
  if (ip === undefined) return undefined;
  // Normalise the IPv4-mapped IPv6 form so log queries match.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

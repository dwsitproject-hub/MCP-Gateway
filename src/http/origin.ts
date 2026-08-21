/**
 * Origin validation for /mcp (review B3).
 *
 * The specification's requirement is narrow and precise:
 *
 *   "Servers MUST validate the Origin header on all incoming connections to
 *    prevent DNS rebinding attacks. If the Origin header is PRESENT AND INVALID,
 *    servers MUST respond with HTTP 403 Forbidden."
 *
 * An ABSENT Origin must therefore be allowed. This matters operationally: Claude
 * calls a custom connector from Anthropic's cloud infrastructure, not from the
 * user's browser, so those server-to-server requests may carry no Origin at all.
 * The TSD's "unknown origins rejected 403" would, if implemented as
 * "absent or not allow-listed", 403 every single tool call.
 *
 * The DNS-rebinding threat this control addresses applies to loopback-bound
 * servers. For a public gateway it is defence in depth; the bearer token is the
 * actual access control.
 */
import type { NextFunction, Request, Response } from 'express';
import { cfg } from './../core/config.js';
import { logger } from './../core/logger.js';

export function isAllowedOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return cfg.ALLOWED_ORIGINS.some((allowed) => {
    try {
      return new URL(allowed).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

export function validateOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // Absent Origin: allowed. This is a server-to-server call, not a browser one.
  if (origin === undefined) {
    next();
    return;
  }

  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined || value === '' || value === 'null') {
    next();
    return;
  }

  if (isAllowedOrigin(value)) {
    next();
    return;
  }

  logger.warn({ origin: value }, 'rejected request with a disallowed Origin');
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Origin not allowed' },
    id: null,
  });
}

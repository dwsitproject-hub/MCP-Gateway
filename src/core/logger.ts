/**
 * Structured JSON logging (TSD Section 2: pino, no PII beyond user id).
 *
 * Secret redaction is belt-and-braces: nothing should ever be logged that contains
 * a credential, but S5 requires that if it happens the value does not survive.
 */
import { createRequire } from 'node:module';
import { pino } from 'pino';
import { cfg } from './config.js';

const REDACT_PATHS = [
  'password',
  'pass',
  '*.password',
  '*.pass',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'client_secret',
  '*.client_secret',
  'code_verifier',
  '*.code_verifier',
  'refresh_token',
  '*.refresh_token',
  'access_token',
  '*.access_token',
  'KLIP_SVC_PASS',
];

/**
 * Human-readable output is opt-in and best-effort.
 *
 * It used to be enabled whenever NODE_ENV was "development", which crash-looped the
 * production container: pino-pretty is a devDependency and the runtime image is
 * built with `npm ci --omit=dev`, so pino threw an unresolvable-transport error at
 * import time with no usable message. Structured JSON is the only thing the service
 * actually needs, so a missing pretty-printer must never stop it from starting.
 */
function prettyTransport(): Record<string, unknown> {
  if (cfg.LOG_PRETTY !== true) return {};
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { transport: { target: 'pino-pretty', options: { colorize: true } } };
  } catch {
    // Not installed (production image). Fall back to JSON rather than failing.
    return {};
  }
}

export const logger = pino({
  level: cfg.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: { service: 'mcp-gateway', klip_env: cfg.KLIP_ENV },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...prettyTransport(),
});

export type Logger = typeof logger;

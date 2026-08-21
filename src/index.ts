/**
 * Entrypoint.
 *
 * Boot order is deliberate: everything that can refuse to start does so before
 * the listener opens, so a misconfigured gateway fails loudly instead of serving
 * wrong answers.
 *   1. config validation (fail-fast on placeholders / env mismatch)
 *   2. Appendix A route-map gate - refuses to serve KLIP production unverified
 *   3. migrations
 *   4. signing keys
 *   5. listen on loopback (T-2)
 */
import { createApp } from './http/app.js';
import { cfg } from './core/config.js';
import { logger } from './core/logger.js';
import { runMigrations } from './core/migrate.js';
import { loadKeys } from './auth/keys.js';
import { closePool } from './core/db.js';
import { flush as flushAudit } from './core/audit.js';
import { assertVerified, verificationGaps } from './adapters/klip/routes.js';
import { pruneExpired } from './auth/tokens.js';
import { pruneState as pruneHubState, probe as hubProbe } from './auth/hub.js';
import { purgeExpired } from './core/cache.js';
import { SERVER_INFO } from './mcp/server.js';
import { toolNames } from './tools/klip/index.js';

const HOUSEKEEPING_INTERVAL_MS = 15 * 60_000;

async function main(): Promise<void> {
  logger.info(
    { version: SERVER_INFO.version, klipEnv: cfg.KLIP_ENV, nodeEnv: cfg.NODE_ENV, resource: cfg.resourceIdentifier },
    'starting MCP gateway',
  );

  // Appendix A gate: an unreconciled route map must never reach production data.
  assertVerified(cfg.KLIP_ENV);
  const gaps = verificationGaps();
  if (gaps.length > 0) {
    logger.warn(
      { gaps: gaps.length },
      'KLIP route map is not yet reconciled (TSD Appendix A). Staging only - run `npm run cli -- routes:verify`.',
    );
  }

  await runMigrations();
  await loadKeys();

  // Fail loudly at boot rather than when the first pilot user tries to sign in.
  if (cfg.hubEnabled) {
    const hubStatus = await hubProbe();
    if (hubStatus.ok) {
      logger.info({ issuer: cfg.HUB_ISSUER, redirectUri: cfg.hubRedirectUri }, 'Downstream Hub OIDC ready');
    } else {
      logger.error(
        { issuer: cfg.HUB_ISSUER, detail: hubStatus.detail },
        'Downstream Hub OIDC discovery FAILED - pilot users cannot sign in until this is fixed',
      );
    }
  } else {
    logger.warn('Downstream Hub OIDC is not configured; the break-glass password path is the only way in');
  }

  const app = createApp();

  const server = app.listen(cfg.PORT, cfg.BIND_ADDRESS, () => {
    logger.info(
      { port: cfg.PORT, bind: cfg.BIND_ADDRESS, tools: toolNames.length },
      'listening (public access is via nginx only - T-2)',
    );
  });

  const housekeeping = setInterval(() => {
    purgeExpired();
    void pruneExpired().catch((err: Error) => logger.warn({ err: err.message }, 'token pruning failed'));
    void pruneHubState().catch((err: Error) => logger.warn({ err: err.message }, 'hub state pruning failed'));
  }, HOUSEKEEPING_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    clearInterval(housekeeping);
    server.close(() => {
      void flushAudit()
        .catch(() => undefined)
        .then(() => closePool())
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal startup error');
  process.exit(1);
});

/**
 * Express application assembly.
 *
 * Route order matters:
 *   1. security headers + body/cookie parsing
 *   2. our metadata overrides (they must win over the SDK router's versions)
 *   3. the SDK's mcpAuthRouter: /authorize, /token, /register, /revoke, metadata
 *   4. our consent POST handlers, which complete the /authorize flow
 *   5. /mcp behind requireBearerAuth
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { cfg } from './../core/config.js';
import { logger } from './../core/logger.js';
import { provider } from './../auth/provider.js';
import { jwks } from './../auth/keys.js';
import { SCOPE } from './../auth/tokens.js';
import { handleMcpRequest } from './../mcp/server.js';
import { consentRouter } from './consent.js';
import { healthRouter } from './health.js';
import { validateOrigin } from './origin.js';
import { clientIpOf } from './clientIp.js';

const BODY_LIMIT = '64kb';

export const RESOURCE_METADATA_URL = getOAuthProtectedResourceMetadataUrl(new URL(cfg.resourceIdentifier));

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // nginx also sets HSTS; setting it here keeps the guarantee if the proxy config drifts.
  if (cfg.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Protected-resource metadata document (RFC 9728).
 *
 * Review B4: it MUST name `resource` (the canonical MCP server URI) and at least
 * one `authorization_servers` entry, and it is served at BOTH the path-inserted
 * location that clients try first and the root location they fall back to.
 */
function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: cfg.resourceIdentifier,
    resource_name: 'Energi-Up MCP Gateway (KLIP, read-only)',
    authorization_servers: [cfg.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    jwks_uri: `${cfg.PUBLIC_URL}/.well-known/jwks.json`,
  };
}

export function createApp(): Express {
  const app = express();

  // Only the local nginx may set X-Forwarded-For (review H9.3).
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(cookieParser());

  app.use(healthRouter());

  // --- metadata -------------------------------------------------------------
  app.get('/.well-known/jwks.json', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(await jwks());
  });

  // Served ahead of the SDK router so the extra RFC 9207 advertisement wins.
  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    const metadata = createOAuthMetadata({
      provider,
      issuerUrl: new URL(cfg.issuer),
      scopesSupported: [SCOPE],
    }) as unknown as Record<string, unknown>;
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      ...metadata,
      // `new URL(issuer).href` appends a trailing slash, which would NOT string-match
      // the `iss` we sign into tokens and put on the authorization response. RFC 9207
      // mandates simple string comparison with no normalisation, and clients must
      // reject a mismatch - so pin the no-slash form the spec recommends everywhere.
      issuer: cfg.issuer,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // RFC 9207: we emit `iss` on authorization responses, so we must say so.
      authorization_response_iss_parameter_supported: true,
      jwks_uri: `${cfg.PUBLIC_URL}/.well-known/jwks.json`,
    });
  });

  for (const path of ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource/mcp`]) {
    app.get(path, (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(protectedResourceMetadata());
    });
  }

  // --- OAuth endpoints from the SDK ----------------------------------------
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(cfg.issuer),
      baseUrl: new URL(cfg.PUBLIC_URL),
      resourceServerUrl: new URL(cfg.resourceIdentifier),
      scopesSupported: [SCOPE],
      resourceName: 'Energi-Up MCP Gateway (KLIP, read-only)',
    }),
  );

  app.use(consentRouter());

  // --- MCP endpoint ---------------------------------------------------------
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: RESOURCE_METADATA_URL,
  });

  app.post('/mcp', validateOrigin, bearer, async (req: Request, res: Response) => {
    await handleMcpRequest(req, res, req.body, clientIpOf(req));
  });

  /**
   * Protocol revision 2026-07-28 removed the GET notification stream and DELETE
   * session teardown. A server that speaks only the modern shape should answer
   * 405 to that legacy traffic (review B5). Older clients that need them will be
   * served by re-enabling the stateful transport, not by silently 404-ing here.
   */
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', validateOrigin, bearer, (_req: Request, res: Response) => {
      res.setHeader('Allow', 'POST');
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32601, message: 'This server is stateless: use POST. Sessions and the GET stream are not supported.' },
        id: null,
      });
    });
  }

  // --- fallbacks ------------------------------------------------------------
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message }, 'unhandled express error');
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

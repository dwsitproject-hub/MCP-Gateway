/**
 * OAuthServerProvider implementation (review H1).
 *
 * The SDK's mcpAuthRouter owns the endpoints, metadata documents, PKCE
 * enforcement, DCR and error shapes. This file supplies only what is genuinely
 * ours: where codes and tokens live, and how a user proves who they are.
 *
 * Authorization-code binding (OAuth 2.1 / RFC 6749 4.1.3): each code row is bound
 * to client_id, redirect_uri, the PKCE challenge, the user and the RFC 8707
 * resource. The TSD skeleton bound only the challenge and the user, which would
 * let a code minted for one client be redeemed by another.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidRequestError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { cfg } from './../core/config.js';
import { query, queryOne } from './../core/db.js';
import { logger } from './../core/logger.js';
import * as audit from './../core/audit.js';
import { clientsStore, isAllowedRedirectUri } from './clients.js';
import { loadKeys } from './keys.js';
import { renderLoginPage, loginCsp } from './loginPage.js';
import {
  SCOPE,
  canonicalResource,
  issue,
  rotate,
  revokeRefreshToken,
  verifyAccessToken,
  ResourceMismatchError,
  TokenError,
} from './tokens.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const PENDING_AUDIENCE = 'urn:energiup:mcp-gateway:pending-authorization';
const PENDING_TTL_SECONDS = 600;

export interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string | undefined;
  resource?: string | undefined;
  csrf: string;
}

// ---------------------------------------------------------------------------
// Pending-authorization token
//
// The authorization request has to survive the login POST. Signing it (rather than
// adding a table) keeps it tamper-proof and self-expiring, and the unguessable
// token doubles as the CSRF token for the consent form.
// ---------------------------------------------------------------------------

export async function signPending(pending: PendingAuthorization): Promise<string> {
  const { privateKey, kid } = await loadKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...pending })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(cfg.issuer)
    .setAudience(PENDING_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + PENDING_TTL_SECONDS)
    .sign(privateKey);
}

export async function verifyPending(token: string): Promise<PendingAuthorization> {
  const { publicKey } = await loadKeys();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: cfg.issuer,
    audience: PENDING_AUDIENCE,
    algorithms: ['RS256'],
  });
  const pending: PendingAuthorization = {
    clientId: String(payload.clientId),
    clientName: String(payload.clientName),
    redirectUri: String(payload.redirectUri),
    codeChallenge: String(payload.codeChallenge),
    scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [SCOPE],
    csrf: String(payload.csrf),
  };
  if (typeof payload.state === 'string') pending.state = payload.state;
  if (typeof payload.resource === 'string') pending.resource = payload.resource;
  return pending;
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export interface IssuedCode {
  code: string;
  redirectTo: string;
}

export async function createAuthorizationCode(
  pending: PendingAuthorization,
  userId: string,
): Promise<IssuedCode> {
  const code = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::INTERVAL)`,
    [
      sha256(code),
      pending.clientId,
      userId,
      pending.redirectUri,
      pending.codeChallenge,
      pending.scopes.join(' '),
      pending.resource ?? null,
      String(cfg.AUTH_CODE_TTL_SECONDS),
    ],
  );

  const target = new URL(pending.redirectUri);
  target.searchParams.set('code', code);
  if (pending.state !== undefined) target.searchParams.set('state', pending.state);
  // RFC 9207: identify the issuer in the authorization response so the client can
  // detect a mix-up attack. Advertised via authorization_response_iss_parameter_supported.
  target.searchParams.set('iss', cfg.issuer);

  return { code, redirectTo: target.toString() };
}

interface CodeRow {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  /**
   * Begin the flow. The SDK has already validated client_id, redirect_uri and the
   * presence of an S256 challenge, so this renders the login and consent page.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Defence in depth: re-check the redirect target even though the SDK matched it
    // against the registration, in case a registration predates a policy change.
    if (!isAllowedRedirectUri(params.redirectUri)) {
      res.status(400).type('text/plain').send('redirect_uri is not permitted by this authorization server');
      return;
    }

    // RFC 8707: refuse to start a flow for a resource that is not this server.
    // Honouring an arbitrary `resource` would mint a token bound to something we do
    // not control, and verification would reject it anyway.
    if (params.resource !== undefined) {
      try {
        canonicalResource(params.resource.toString());
      } catch {
        const target = new URL(params.redirectUri);
        target.searchParams.set('error', 'invalid_target');
        target.searchParams.set(
          'error_description',
          `resource must be ${cfg.resourceIdentifier} (or its origin)`,
        );
        if (params.state !== undefined) target.searchParams.set('state', params.state);
        target.searchParams.set('iss', cfg.issuer);
        logger.warn({ requested: params.resource.toString() }, 'rejected authorization for a foreign resource');
        res.redirect(302, target.toString());
        return;
      }
    }

    const csrf = randomBytes(16).toString('base64url');
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      clientName: client.client_name ?? 'an application',
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [SCOPE],
      csrf,
    };
    if (params.state !== undefined) pending.state = params.state;
    if (params.resource !== undefined) pending.resource = params.resource.toString();

    const pendingToken = await signPending(pending);

    res
      .status(200)
      .cookie('mcp_csrf', csrf, {
        httpOnly: true,
        secure: cfg.isProduction,
        sameSite: 'lax',
        maxAge: PENDING_TTL_SECONDS * 1000,
        path: '/authorize',
      })
      // Both buttons on this page 302 off-origin, and Chrome re-checks form-action on
      // every redirect hop - so those destinations must be named or the buttons do nothing.
      .setHeader('Content-Security-Policy', loginCsp([pending.redirectUri, cfg.HUB_ISSUER ?? '']));
    res.type('html').send(
      renderLoginPage({
        pendingToken,
        csrfToken: csrf,
        clientName: pending.clientName,
        hubEnabled: cfg.hubEnabled,
        breakGlassEnabled: cfg.BREAK_GLASS_ENABLED,
      }),
    );
  },

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = await queryOne<CodeRow>('SELECT * FROM oauth_codes WHERE code = $1', [sha256(authorizationCode)]);
    // Throwing OAuthError subclasses matters: an ordinary Error becomes a 500
    // server_error, while a client can only act on a 400 invalid_grant.
    if (row === undefined) throw new InvalidGrantError('invalid authorization code');
    if (row.client_id !== client.client_id) throw new InvalidGrantError('authorization code was issued to another client');
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // PKCE itself is verified by the SDK against challengeForAuthorizationCode().
    const hash = sha256(authorizationCode);
    const row = await queryOne<CodeRow>('SELECT * FROM oauth_codes WHERE code = $1', [hash]);

    if (row === undefined) throw new InvalidGrantError('invalid authorization code');
    if (row.client_id !== client.client_id) throw new InvalidGrantError('authorization code was issued to another client');
    if (row.consumed_at !== null) throw new InvalidGrantError('authorization code has already been used');
    if (row.expires_at.getTime() <= Date.now()) throw new InvalidGrantError('authorization code has expired');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidRequestError('redirect_uri does not match the authorization request');
    }
    // RFC 8707: a token must not be minted for a resource other than the one the
    // user authorized.
    const requested = resource?.toString();
    if (requested !== undefined && row.resource !== null && requested !== row.resource) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }
    // ...and that the resource is actually this server.
    try {
      canonicalResource(requested ?? row.resource ?? undefined);
    } catch (err) {
      throw new InvalidTargetError((err as Error).message);
    }

    // Single use: consume atomically so two concurrent redemptions cannot both win.
    const consumed = await query<{ code: string }>(
      'UPDATE oauth_codes SET consumed_at = now() WHERE code = $1 AND consumed_at IS NULL RETURNING code',
      [hash],
    );
    if (consumed.length === 0) throw new InvalidGrantError('authorization code has already been used');

    const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [row.user_id]);
    const tokens = await issue(
      { userId: row.user_id, email: user?.email ?? row.user_id },
      client.client_id,
      requested ?? row.resource ?? undefined,
    );

    await audit
      .write({
        event: 'token_issued',
        ctx: { requestId: audit.newRequestId(), userId: user?.email ?? row.user_id, oauthClientId: client.client_id },
        outcome: 'authorization_code',
      })
      .catch(() => undefined);

    return tokens as unknown as OAuthTokens;
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    if (_resource !== undefined) {
      try {
        canonicalResource(_resource.toString());
      } catch (err) {
        throw new InvalidTargetError((err as Error).message);
      }
    }
    try {
      const tokens = await rotate(refreshToken, client.client_id);
      return tokens as unknown as OAuthTokens;
    } catch (err) {
      if (err instanceof ResourceMismatchError) throw new InvalidTargetError(err.message);
      if (err instanceof TokenError) {
        if (err.reason === 'reuse_detected') {
          await audit
            .write({
              event: 'token_revoked',
              ctx: { requestId: audit.newRequestId(), userId: 'system', oauthClientId: client.client_id },
              outcome: 'refresh_reuse_family_revoked',
              detail: { severity: 'high' },
            })
            .catch(() => undefined);
        }
        logger.warn({ reason: err.reason, clientId: client.client_id }, 'refresh exchange rejected');
        // A leaked-and-reused token, an expired one and a disabled user are all
        // invalid_grant to the client; the distinction stays in the audit log.
        throw new InvalidGrantError(
          err.reason === 'reuse_detected'
            ? 'refresh token has already been used; the token family has been revoked'
            : 'refresh token is not valid',
        );
      }
      throw err;
    }
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyAccessToken(token);
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // RFC 7009: revoking an unknown or already-revoked token is a no-op success.
    await revokeRefreshToken(request.token);
  },
};

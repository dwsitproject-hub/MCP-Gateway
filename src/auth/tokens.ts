/**
 * Token issuance and verification (TSD Section 8.2).
 *
 * Access token: RS256 JWT, TTL from config, verified on every /mcp request.
 * Refresh token: opaque 256-bit, stored SHA-256 hashed, rotated on every use;
 * reuse of a consumed token revokes the entire family.
 *
 * Review fix B4 - RFC 8707 audience binding:
 *   `aud` is the CANONICAL RESOURCE URI of this MCP server
 *   (https://host/mcp), not the bare hostname. The specification requires the
 *   server to validate that a token was issued specifically for it, using the
 *   same identifier the client sent as `resource`. A bare hostname would never
 *   equal a conforming client's `resource` value.
 *
 * Revocation has three layers, because access tokens are stateless:
 *   1. per-jti denylist (single token, user disable)
 *   2. a global not-before epoch (the kill switch, S8 - one row, no enumeration)
 *   3. refresh-family revocation on reuse detection
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { cfg } from './../core/config.js';
import { query, queryOne } from './../core/db.js';
import { logger } from './../core/logger.js';
import { loadKeys } from './keys.js';
import { isActive } from './users.js';

export const SCOPE = 'klip:read';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface Subject {
  userId: string;
  email: string;
}

/** Raised when a client asks for a token targeting a resource this server is not. */
export class ResourceMismatchError extends Error {
  constructor(readonly requested: string) {
    super(`resource "${requested}" is not this MCP server (${cfg.resourceIdentifier})`);
    this.name = 'ResourceMismatchError';
  }
}

/**
 * Validate the RFC 8707 `resource` a client asked for, and return the canonical
 * identifier to bind the token to.
 *
 * This is the confused-deputy guard. Honouring an arbitrary `resource` would mint
 * a token audience-bound to something we do not control - and, since verification
 * only ever accepts our own canonical identifier, such a token is also simply
 * broken. Both were observed live: a request carrying
 * `resource=http://localhost:8787/mcp` against a gateway configured for
 * https://mcp-gw.example.com produced a token that every /mcp call then rejected.
 *
 * Accepted forms (the spec asks servers to be robust about case and trailing slash):
 *   https://mcp-gw.example.com/mcp   - the canonical identifier
 *   https://mcp-gw.example.com       - the bare origin
 * Anything else is invalid_target.
 */
export function canonicalResource(requested: string | undefined): string {
  if (requested === undefined || requested === '') return cfg.resourceIdentifier;
  const normalise = (value: string): string => value.replace(/\/+$/, '').toLowerCase();
  const asked = normalise(requested);
  if (asked === normalise(cfg.resourceIdentifier) || asked === normalise(cfg.PUBLIC_URL)) {
    return cfg.resourceIdentifier;
  }
  throw new ResourceMismatchError(requested);
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

async function signAccessToken(subject: Subject, clientId: string, resource: string, jti: string): Promise<string> {
  const { privateKey, kid } = await loadKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: SCOPE, email: subject.email, client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setIssuer(cfg.issuer)
    .setAudience(resource)
    .setSubject(subject.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + cfg.ACCESS_TOKEN_TTL_SECONDS)
    .setJti(jti)
    .sign(privateKey);
}

export async function issue(
  subject: Subject,
  clientId: string,
  resource: string | undefined,
  familyId?: string,
): Promise<IssuedTokens> {
  // Always bind to OUR canonical identifier; a mismatched request never gets here.
  const audience = canonicalResource(resource);
  const jti = randomUUID();
  const accessToken = await signAccessToken(subject, clientId, audience, jti);

  const refreshToken = randomBytes(32).toString('base64url');
  const family = familyId ?? randomUUID();
  await query(
    `INSERT INTO oauth_tokens (token_hash, family_id, client_id, user_id, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::INTERVAL)`,
    [sha256(refreshToken), family, clientId, subject.userId, SCOPE, audience, String(cfg.REFRESH_TOKEN_TTL_SECONDS)],
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: cfg.ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: SCOPE,
  };
}

// ---------------------------------------------------------------------------
// Refresh rotation with reuse detection
// ---------------------------------------------------------------------------

interface RefreshRow {
  token_hash: string;
  family_id: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid_grant' | 'reuse_detected' | 'expired' | 'user_disabled',
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await query('UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [familyId]);
  logger.warn({ familyId, reason }, 'refresh token family revoked');
}

export async function rotate(refreshToken: string, clientId: string): Promise<IssuedTokens> {
  const row = await queryOne<RefreshRow>('SELECT * FROM oauth_tokens WHERE token_hash = $1', [sha256(refreshToken)]);

  if (row === undefined) throw new TokenError('unknown refresh token', 'invalid_grant');
  if (row.client_id !== clientId) throw new TokenError('refresh token was issued to another client', 'invalid_grant');

  // Reuse of an already-consumed token means the token leaked: kill the family.
  if (row.consumed_at !== null) {
    await revokeFamily(row.family_id, 'refresh token reuse detected');
    throw new TokenError('refresh token has already been used', 'reuse_detected');
  }

  if (row.revoked_at !== null) throw new TokenError('refresh token was revoked', 'invalid_grant');
  if (row.expires_at.getTime() <= Date.now()) throw new TokenError('refresh token expired', 'expired');

  if (!(await isActive(row.user_id))) {
    await revokeFamily(row.family_id, 'user disabled');
    throw new TokenError('user is disabled', 'user_disabled');
  }

  await query('UPDATE oauth_tokens SET consumed_at = now() WHERE token_hash = $1', [row.token_hash]);

  const email = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [row.user_id]);
  return issue(
    { userId: row.user_id, email: email?.email ?? row.user_id },
    clientId,
    row.resource ?? undefined,
    row.family_id,
  );
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await query('UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
    sha256(refreshToken),
  ]);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Access tokens issued at or before this instant are invalid (kill switch).
 *
 * node-postgres maps the timestamptz value `-infinity` to the JavaScript NUMBER
 * -Infinity, not to a Date - so calling .getTime() on it throws, which broke every
 * single token verification until it was caught in the end-to-end smoke test.
 * Read the value defensively.
 */
async function notBefore(): Promise<number> {
  const row = await queryOne<{ not_before: unknown }>('SELECT not_before FROM auth_revocation_epoch WHERE id = TRUE');
  if (row === undefined) return 0;
  const raw = row.not_before;
  const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export async function verifyAccessToken(token: string): Promise<AuthInfo> {
  const { publicKey } = await loadKeys();

  // Every rejection below MUST be an InvalidTokenError, so the bearer middleware
  // answers 401 and the client knows to re-authenticate. A plain Error becomes a
  // 500 server_error - observed during the S8 drill, where a correctly revoked
  // token produced 500 instead of 401 and looked like a server fault.
  let payload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer: cfg.issuer,
      // Audience binding: only tokens minted for THIS resource are accepted.
      audience: cfg.resourceIdentifier,
      algorithms: ['RS256'],
      clockTolerance: 5,
    }));
  } catch {
    // Signature, issuer, audience or expiry failure - never say which.
    throw new InvalidTokenError('token is not valid for this resource');
  }

  const scopes = String(payload.scope ?? '').split(' ').filter(Boolean);
  if (!scopes.includes(SCOPE)) throw new InvalidTokenError('token does not carry the klip:read scope');

  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
  if (jti === undefined) throw new InvalidTokenError('token has no jti');

  const denied = await queryOne<{ jti: string }>('SELECT jti FROM revoked_access_tokens WHERE jti = $1', [jti]);
  if (denied !== undefined) throw new InvalidTokenError('token has been revoked');

  const cutoff = await notBefore();
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
  if (cutoff > 0 && issuedAt <= cutoff) throw new InvalidTokenError('token was revoked by an administrator');

  const userId = typeof payload.sub === 'string' ? payload.sub : undefined;
  if (userId === undefined) throw new InvalidTokenError('token has no subject');
  if (!(await isActive(userId))) throw new InvalidTokenError('the account for this token is disabled');

  const info: AuthInfo = {
    token,
    clientId: typeof payload.client_id === 'string' ? payload.client_id : 'unknown',
    scopes,
    ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
    resource: new URL(cfg.resourceIdentifier),
    extra: { sub: userId, email: typeof payload.email === 'string' ? payload.email : userId, jti },
  };
  return info;
}

// ---------------------------------------------------------------------------
// Kill switch and per-user revocation
// ---------------------------------------------------------------------------

/** S8: invalidate every issued token in one statement. */
export async function revokeAll(reason: string): Promise<{ refreshTokens: number }> {
  await query('UPDATE auth_revocation_epoch SET not_before = now(), updated_at = now(), reason = $1 WHERE id = TRUE', [
    reason,
  ]);
  const rows = await query<{ count: string }>(
    `WITH revoked AS (
       UPDATE oauth_tokens SET revoked_at = now() WHERE revoked_at IS NULL RETURNING 1
     ) SELECT count(*)::text AS count FROM revoked`,
  );
  return { refreshTokens: Number(rows[0]?.count ?? 0) };
}

/** Revoke everything belonging to one user (used by user:disable). */
export async function revokeUser(userId: string, reason: string): Promise<void> {
  await query('UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  logger.info({ userId, reason }, 'revoked all refresh tokens for user');
}

/** Housekeeping: drop expired denylist and refresh rows. */
export async function pruneExpired(): Promise<void> {
  await query('DELETE FROM revoked_access_tokens WHERE expires_at < now()');
  await query("DELETE FROM oauth_codes WHERE expires_at < now() - INTERVAL '1 day'");
  await query("DELETE FROM oauth_tokens WHERE expires_at < now() - INTERVAL '7 days'");
}

/**
 * OAuth client store (T-8).
 *
 * Registered redirect_uris are restricted to the configured origins. The check is
 * done by URL PARSING with an exact host comparison, not by regex: regex host
 * matching is a recurring source of bypasses even when a given pattern happens to
 * be safe (review, Medium findings).
 *
 * Note on registration paths: the current MCP specification marks RFC 7591 dynamic
 * client registration as deprecated in favour of Client ID Metadata Documents, and
 * Anthropic's connector UI also accepts a manually entered client id and secret.
 * Both paths work here - DCR is supported for today's clients, and
 * `cli.js client:add` pre-registers one for the manual path.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { query, queryOne } from './../core/db.js';
import { cfg } from './../core/config.js';
import { logger } from './../core/logger.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_secret_expires_at: Date | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  token_endpoint_auth_method: string;
  disabled_at: Date | null;
}

/**
 * A redirect URI is acceptable only when its ORIGIN exactly equals one of the
 * allowed origins. This rejects claude.ai.evil.com, claude.ai@evil.com,
 * sub.claude.ai and http downgrades without relying on pattern subtleties.
 */
export function isAllowedRedirectUri(uri: string, opts: { loopback?: boolean } = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.hash !== '') return false;
  if (opts.loopback === true && isLoopbackRedirect(uri, parsed)) return true;
  if (parsed.protocol !== 'https:') return false;
  return cfg.ALLOWED_REDIRECT_ORIGINS.some((allowed) => {
    try {
      return new URL(allowed).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

/**
 * A native app on the user's own machine (Milo) receives its code on the loopback
 * interface: RFC 8252 section 7.3. Only the literal 127.0.0.1 - never the name
 * "localhost", which can resolve elsewhere (section 8.3) - and any port, which the
 * app picks. A code delivered here never leaves the machine that asked for it.
 *
 * Only for clients an admin pre-registers from a shell (`client:add`) with
 * ALLOW_LOOPBACK_REDIRECTS on. Dynamic registration never accepts it, so the public
 * /register endpoint cannot be used to mint loopback clients.
 */
function isLoopbackRedirect(uri: string, parsed: URL): boolean {
  // Written literally, too: the URL parser also turns 0x7f000001 or 2130706433 into
  // 127.0.0.1, and a registered value should read as what it is.
  return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && /^http:\/\/127\.0\.0\.1(:\d{1,5})?\//.test(uri);
}

function toClientInformation(row: ClientRow): OAuthClientInformationFull {
  const info: Record<string, unknown> = {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: row.redirect_uris,
    grant_types: row.grant_types,
    response_types: row.response_types,
    scope: row.scope,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
  };
  if (row.client_secret_expires_at !== null) {
    info.client_secret_expires_at = Math.floor(row.client_secret_expires_at.getTime() / 1000);
  }
  return info as unknown as OAuthClientInformationFull;
}

export const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await queryOne<ClientRow>(
      'SELECT * FROM oauth_clients WHERE client_id = $1 AND disabled_at IS NULL',
      [clientId],
    );
    return row === undefined ? undefined : toClientInformation(row);
  },

  async registerClient(client): Promise<OAuthClientInformationFull> {
    const redirectUris = client.redirect_uris ?? [];
    const rejected = redirectUris.filter((uri) => !isAllowedRedirectUri(uri));
    if (redirectUris.length === 0 || rejected.length > 0) {
      logger.warn({ rejected, allowed: cfg.ALLOWED_REDIRECT_ORIGINS }, 'rejected client registration (T-8)');
      // Must be an OAuthError subclass, or the SDK's register handler turns it into
      // a 500 server_error instead of the 400 invalid_client_metadata a client can act on.
      throw new InvalidClientMetadataError(
        `redirect_uris must be https URLs whose origin is exactly one of: ${cfg.ALLOWED_REDIRECT_ORIGINS.join(', ')}`,
      );
    }

    const clientId = randomUUID();
    const authMethod = client.token_endpoint_auth_method ?? 'none';
    const secret = authMethod === 'none' ? undefined : randomBytes(32).toString('base64url');

    await query(
      `INSERT INTO oauth_clients
         (client_id, client_secret_hash, client_name, redirect_uris, grant_types, response_types, scope,
          token_endpoint_auth_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        clientId,
        secret === undefined ? null : sha256(secret),
        client.client_name ?? 'unnamed client',
        redirectUris,
        client.grant_types ?? ['authorization_code', 'refresh_token'],
        client.response_types ?? ['code'],
        'klip:read',
        authMethod,
      ],
    );

    logger.info({ clientId, clientName: client.client_name, redirectUris }, 'client registered');

    const info: Record<string, unknown> = {
      client_id: clientId,
      client_name: client.client_name ?? 'unnamed client',
      redirect_uris: redirectUris,
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
      scope: 'klip:read',
      token_endpoint_auth_method: authMethod,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    if (secret !== undefined) info.client_secret = secret;
    return info as unknown as OAuthClientInformationFull;
  },
};

/** Pre-register a client for the manual "Advanced settings" path in the connector UI. */
export async function preRegister(
  clientName: string,
  redirectUris: string[],
  withSecret: boolean,
): Promise<{ clientId: string; clientSecret?: string }> {
  const loopback = cfg.ALLOW_LOOPBACK_REDIRECTS;
  const rejected = redirectUris.filter((uri) => !isAllowedRedirectUri(uri, { loopback }));
  if (rejected.length > 0) {
    const hint = !loopback && rejected.some((u) => u.startsWith('http://127.0.0.1')) ? ' (set ALLOW_LOOPBACK_REDIRECTS=true for a local app)' : '';
    throw new Error(`disallowed redirect_uris: ${rejected.join(', ')}${hint}`);
  }

  const clientId = randomUUID();
  const secret = withSecret ? randomBytes(32).toString('base64url') : undefined;
  await query(
    `INSERT INTO oauth_clients
       (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, $2, $3, $4, $5)`,
    [clientId, secret === undefined ? null : sha256(secret), clientName, redirectUris, withSecret ? 'client_secret_post' : 'none'],
  );
  return secret === undefined ? { clientId } : { clientId, clientSecret: secret };
}

export interface ClientSummary {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  has_secret: boolean;
  created_at: Date;
  disabled_at: Date | null;
  /** Refresh tokens still usable: signed-in sessions that can renew. */
  live_sessions: number;
  last_sign_in: Date | null;
}

/** Every registered client (CLI client:list). Read-only. */
export async function listClients(): Promise<ClientSummary[]> {
  return query<ClientSummary>(
    `SELECT c.client_id, c.client_name, c.redirect_uris,
            (c.client_secret_hash IS NOT NULL) AS has_secret, c.created_at, c.disabled_at,
            COUNT(t.token_hash) FILTER (
              WHERE t.revoked_at IS NULL AND t.consumed_at IS NULL AND t.expires_at > now())::int AS live_sessions,
            MAX(t.created_at) AS last_sign_in
       FROM oauth_clients c
       LEFT JOIN oauth_tokens t ON t.client_id = c.client_id
      GROUP BY c.client_id
      ORDER BY c.created_at`,
  );
}

/**
 * Disable a client (CLI client:disable): no new sign-ins or token renewals, and its refresh
 * tokens are revoked. Access tokens already issued run out within ACCESS_TOKEN_TTL_SECONDS.
 * Returns the client's name, or undefined when there is no such enabled client.
 */
export async function disableClient(clientId: string): Promise<{ name: string; revoked: number } | undefined> {
  const row = await queryOne<{ client_name: string }>(
    'UPDATE oauth_clients SET disabled_at = now() WHERE client_id = $1 AND disabled_at IS NULL RETURNING client_name',
    [clientId],
  );
  if (row === undefined) return undefined;
  const revoked = await query<{ n: number }>(
    `WITH r AS (UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL RETURNING 1)
     SELECT count(*)::int AS n FROM r`,
    [clientId],
  );
  logger.info({ clientId, name: row.client_name }, 'client disabled');
  return { name: row.client_name, revoked: revoked[0]?.n ?? 0 };
}

/** Re-enable a disabled client (CLI client:enable). Its users sign in again. */
export async function enableClient(clientId: string): Promise<{ name: string } | undefined> {
  const row = await queryOne<{ client_name: string }>(
    'UPDATE oauth_clients SET disabled_at = NULL WHERE client_id = $1 AND disabled_at IS NOT NULL RETURNING client_name',
    [clientId],
  );
  return row === undefined ? undefined : { name: row.client_name };
}

/** Constant-time secret comparison for the pre-registered/confidential client path. */
export async function verifyClientSecret(clientId: string, secret: string): Promise<boolean> {
  const row = await queryOne<{ client_secret_hash: string | null }>(
    'SELECT client_secret_hash FROM oauth_clients WHERE client_id = $1 AND disabled_at IS NULL',
    [clientId],
  );
  if (row?.client_secret_hash == null) return false;
  const expected = Buffer.from(row.client_secret_hash, 'hex');
  const actual = Buffer.from(sha256(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

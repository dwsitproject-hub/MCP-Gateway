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
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.hash !== '') return false;
  return cfg.ALLOWED_REDIRECT_ORIGINS.some((allowed) => {
    try {
      return new URL(allowed).origin === parsed.origin;
    } catch {
      return false;
    }
  });
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
  const rejected = redirectUris.filter((uri) => !isAllowedRedirectUri(uri));
  if (rejected.length > 0) throw new Error(`disallowed redirect_uris: ${rejected.join(', ')}`);

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

/**
 * Downstream Hub OIDC relying party (review H2).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * The Hub authenticates the human. It does NOT become the authorization server
 * that Claude talks to, and we deliberately do not use the SDK's
 * ProxyOAuthServerProvider, because proxying would:
 *   - hand Claude a HUB token, whose `aud` is the Hub and not this MCP server,
 *     breaking the RFC 8707 audience binding (review B4);
 *   - give Claude whatever scopes the Hub issues, instead of just `klip:read`;
 *   - move token issuance out of our control, so the S8 kill switch could no
 *     longer invalidate live sessions.
 *
 * So the gateway stays the authorization server. The Hub is one step inside our
 * own /authorize flow, and the /authorize contract Claude sees never changes -
 * exactly as TSD Section 8.3 anticipated.
 *
 * There are two independent PKCE exchanges in play. Do not conflate them:
 *   1. Claude  -> gateway : the client's own code_challenge (handled by the SDK)
 *   2. gateway -> Hub     : our code_verifier, stored server-side in hub_auth_state
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { cfg } from './../core/config.js';
import { logger } from './../core/logger.js';
import { query, queryOne } from './../core/db.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface HubMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

let cachedMetadata: { at: number; value: HubMetadata } | undefined;
const METADATA_TTL_MS = 15 * 60_000;

export class HubError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'not_configured'
      | 'discovery_failed'
      | 'token_exchange_failed'
      | 'id_token_invalid'
      | 'state_invalid'
      | 'not_permitted',
  ) {
    super(message);
    this.name = 'HubError';
  }
}

function requireConfigured(): {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  discoveryUrl: string;
} {
  if (
    !cfg.hubEnabled ||
    cfg.HUB_ISSUER === undefined ||
    cfg.HUB_CLIENT_ID === undefined ||
    cfg.hubDiscoveryUrl === undefined
  ) {
    throw new HubError('Downstream Hub OIDC is not configured', 'not_configured');
  }
  // No secret is required: DWS Hub is a public client using PKCE.
  return {
    issuer: cfg.HUB_ISSUER.replace(/\/+$/, ''),
    clientId: cfg.HUB_CLIENT_ID,
    clientSecret: cfg.HUB_CLIENT_SECRET,
    discoveryUrl: cfg.hubDiscoveryUrl,
  };
}

/**
 * Fetch and cache the Hub's OIDC discovery document.
 *
 * The `issuer` in the document MUST equal the issuer we used to build the URL.
 * That check is what stops a hijacked discovery endpoint from pointing us at an
 * attacker's authorization server.
 */
export async function metadata(): Promise<HubMetadata> {
  const { issuer, discoveryUrl } = requireConfigured();
  const now = Date.now();
  if (cachedMetadata !== undefined && now - cachedMetadata.at < METADATA_TTL_MS) return cachedMetadata.value;

  // DWS Hub serves OIDC under /api/sso, so the discovery document is NOT at the
  // RFC 8414 path derived from the issuer. The URL is configured explicitly and the
  // issuer is still checked against the document below.
  const url = discoveryUrl;
  let body: unknown;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new HubError(`could not read the Hub's OIDC metadata (${(err as Error).message})`, 'discovery_failed');
  }

  const doc = body as Partial<HubMetadata>;
  if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== issuer) {
    throw new HubError(
      `the Hub's metadata declares issuer "${String(doc.issuer)}", which does not match the configured ${issuer}`,
      'discovery_failed',
    );
  }
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[field] !== 'string') {
      throw new HubError(`the Hub's metadata is missing ${field}`, 'discovery_failed');
    }
  }

  const value = doc as HubMetadata;
  cachedMetadata = { at: now, value };
  logger.info({ issuer: value.issuer }, 'Downstream Hub OIDC metadata loaded');
  return value;
}

export type TokenAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * How to present the client credentials at the Hub's token endpoint.
 *
 * This was hardcoded to client_secret_basic, which fails with an opaque "the Hub
 * rejected the sign-in" against a provider that only accepts client_secret_post -
 * and the two are equally common. Read it from discovery instead, with an env
 * override for a Hub whose metadata is incomplete.
 *
 * RFC 8414: when token_endpoint_auth_methods_supported is absent, the default is
 * client_secret_basic.
 */
export function tokenAuthMethod(meta: HubMetadata): TokenAuthMethod {
  const override = cfg.HUB_TOKEN_AUTH_METHOD;
  if (override !== undefined) return override;

  const supported = meta.token_endpoint_auth_methods_supported;

  // A public client is the DWS Hub case: no secret exists, so there is nothing to
  // present. Honour it whenever the Hub says so, or whenever we simply have no secret.
  if (supported?.includes('none') === true || cfg.HUB_CLIENT_SECRET === undefined) return 'none';

  if (supported === undefined || supported.length === 0) return 'client_secret_basic';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';

  logger.warn(
    { supported },
    'the Hub advertises no recognised token auth method; defaulting to basic. Set HUB_TOKEN_AUTH_METHOD if wrong.',
  );
  return 'client_secret_basic';
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksFor: string | undefined;

async function keySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const meta = await metadata();
  if (jwks === undefined || jwksFor !== meta.jwks_uri) {
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    jwksFor = meta.jwks_uri;
  }
  return jwks;
}

// ---------------------------------------------------------------------------
// Round-trip state
// ---------------------------------------------------------------------------

export interface HubRoundTrip {
  /** Opaque value handed to the Hub as `state`; stored hashed. */
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function beginRoundTrip(pendingToken: string): Promise<HubRoundTrip> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');

  await query(
    `INSERT INTO hub_auth_state (state, pending_token, code_verifier, nonce, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::INTERVAL)`,
    [sha256(state), pendingToken, codeVerifier, nonce, String(cfg.HUB_STATE_TTL_SECONDS)],
  );

  return { state, nonce, codeVerifier };
}

interface StateRow {
  state: string;
  pending_token: string;
  code_verifier: string;
  nonce: string;
  expires_at: Date;
  consumed_at: Date | null;
}

/** Consume a state value exactly once. */
export async function consumeRoundTrip(state: string): Promise<{ pendingToken: string; codeVerifier: string; nonce: string }> {
  const hash = sha256(state);
  const rows = await query<StateRow>(
    `UPDATE hub_auth_state SET consumed_at = now()
      WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING *`,
    [hash],
  );
  const row = rows[0];
  if (row === undefined) {
    // Either unknown, already used, or expired - all indistinguishable to the caller.
    throw new HubError('the sign-in request is no longer valid; please start again', 'state_invalid');
  }
  return { pendingToken: row.pending_token, codeVerifier: row.code_verifier, nonce: row.nonce };
}

export async function pruneState(): Promise<void> {
  await query("DELETE FROM hub_auth_state WHERE expires_at < now() - INTERVAL '1 hour'");
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export async function authorizationUrl(trip: HubRoundTrip): Promise<string> {
  const { clientId } = requireConfigured();
  const meta = await metadata();

  const challenge = createHash('sha256').update(trip.codeVerifier).digest('base64url');
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', cfg.hubRedirectUri);
  url.searchParams.set('scope', cfg.HUB_SCOPES);
  url.searchParams.set('state', trip.state);
  url.searchParams.set('nonce', trip.nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Code exchange and ID-token validation
// ---------------------------------------------------------------------------

export interface HubIdentity {
  subject: string;
  email: string;
  displayName: string | null;
  groups: string[];
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function claimAsString(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function claimAsArray(payload: JWTPayload, claim: string): string[] {
  const value = payload[claim];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

/**
 * Exchange the Hub's authorization code and validate the resulting ID token.
 *
 * Validated: signature (against the Hub's JWKS), issuer, audience (our client id),
 * expiry, and the nonce we generated for this round trip. A missing or mismatched
 * nonce is a replay and is refused.
 */
export async function exchangeCode(code: string, codeVerifier: string, expectedNonce: string): Promise<HubIdentity> {
  const { clientId, clientSecret, issuer } = requireConfigured();
  const meta = await metadata();

  const method = tokenAuthMethod(meta);

  /**
   * The parameters DWS Hub requires. `redirect_uri` is mandatory here — omitting it
   * returns `invalid_request`, and a value that differs by even one byte returns
   * `invalid_grant`.
   */
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.hubRedirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  };

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'client_secret_basic' && clientSecret !== undefined) {
    // RFC 6749 2.3.1: both values are form-urlencoded before base64.
    const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  } else if (method === 'client_secret_post' && clientSecret !== undefined) {
    params.client_secret = clientSecret;
  }
  // method === 'none': a public client sends client_id only. No secret exists.

  /**
   * DWS Hub requires a JSON body and answers `unsupported_grant_type` to a
   * form-encoded one — the opposite of virtually every OAuth example, and an error
   * that names the grant type rather than the encoding, so it reads as the wrong
   * problem entirely. JSON is the default; on that specific error we retry once with
   * form encoding so a differently configured provider still works, and log which
   * encoding succeeded so it can be pinned.
   */
  const attempt = async (encoding: 'json' | 'form'): Promise<TokenResponse> => {
    const init: RequestInit =
      encoding === 'json'
        ? {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(15_000),
          }
        : {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(15_000),
          };

    const res = await fetch(meta.token_endpoint, init);
    // Read the body even on an error status: the OAuth error names the real problem,
    // and swallowing it is what turns this into an opaque 400.
    const parsed = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || parsed.error !== undefined) {
      const err = new Error(parsed.error_description ?? parsed.error ?? `HTTP ${res.status}`) as Error & {
        oauthError?: string;
      };
      if (parsed.error !== undefined) err.oauthError = parsed.error;
      throw err;
    }
    return parsed;
  };

  const preferred = cfg.HUB_TOKEN_BODY;
  const fallback = preferred === 'json' ? 'form' : 'json';

  let body: TokenResponse;
  try {
    body = await attempt(preferred);
  } catch (err) {
    const oauthError = (err as Error & { oauthError?: string }).oauthError;
    if (oauthError === 'unsupported_grant_type') {
      logger.warn(
        { tried: preferred, retryingWith: fallback },
        'the Hub rejected the token body encoding; retrying with the other one',
      );
      try {
        body = await attempt(fallback);
        logger.warn(
          { encoding: fallback },
          `token exchange succeeded with ${fallback} encoding - pin it with HUB_TOKEN_BODY=${fallback}`,
        );
      } catch (retryErr) {
        throw new HubError(
          `the Hub rejected the sign-in with both ${preferred} and ${fallback} bodies ` +
            `(${(retryErr as Error).message}), using client auth "${method}".`,
          'token_exchange_failed',
        );
      }
    } else {
      // Name the auth method and encoding: a 401 here is usually one of the two, and
      // without them the failure reads as a bad credential.
      throw new HubError(
        `the Hub rejected the sign-in (${(err as Error).message}) [client auth: ${method}, body: ${preferred}]. ` +
          'If the Hub expects different handling, set HUB_TOKEN_AUTH_METHOD or HUB_TOKEN_BODY.',
        'token_exchange_failed',
      );
    }
  }

  if (body.id_token === undefined) {
    throw new HubError('the Hub returned no id_token', 'id_token_invalid');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(body.id_token, await keySet(), {
      issuer,
      audience: clientId,
      clockTolerance: 5,
    }));
  } catch (err) {
    throw new HubError(`the Hub's identity token failed validation (${(err as Error).message})`, 'id_token_invalid');
  }

  const nonce = claimAsString(payload, 'nonce');
  if (nonce === undefined || nonce !== expectedNonce) {
    throw new HubError('the Hub identity token nonce did not match this sign-in attempt', 'id_token_invalid');
  }

  const subject = claimAsString(payload, 'sub');
  if (subject === undefined) throw new HubError('the Hub identity token has no subject', 'id_token_invalid');

  const email = claimAsString(payload, cfg.HUB_EMAIL_CLAIM) ?? claimAsString(payload, 'email');
  if (email === undefined) {
    throw new HubError(
      `the Hub identity token carries no "${cfg.HUB_EMAIL_CLAIM}" claim, so the user cannot be matched to the pilot list`,
      'id_token_invalid',
    );
  }

  const groups = claimAsArray(payload, cfg.HUB_GROUPS_CLAIM);
  if (cfg.HUB_REQUIRED_GROUP !== undefined) {
    const wanted = cfg.HUB_REQUIRED_GROUP.toLowerCase();
    if (!groups.some((g) => g.toLowerCase() === wanted)) {
      throw new HubError(
        `your Hub account is not a member of "${cfg.HUB_REQUIRED_GROUP}", which is required to use this connector`,
        'not_permitted',
      );
    }
  }

  return {
    subject,
    email: email.toLowerCase(),
    displayName: claimAsString(payload, 'name') ?? claimAsString(payload, 'preferred_username') ?? null,
    groups,
  };
}

/** Health signal: is the Hub's discovery document reachable? */
export async function probe(): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.hubEnabled) return { ok: true, detail: 'not_configured' };
  try {
    const meta = await metadata();
    return { ok: true, detail: meta.issuer };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Clears the cached discovery document and JWKS. Used by tests and after rotation. */
export function resetCache(): void {
  cachedMetadata = undefined;
  jwks = undefined;
  jwksFor = undefined;
}

export async function queryStateCount(): Promise<number> {
  const row = await queryOne<{ n: string }>('SELECT count(*)::text AS n FROM hub_auth_state WHERE consumed_at IS NULL');
  return Number(row?.n ?? 0);
}

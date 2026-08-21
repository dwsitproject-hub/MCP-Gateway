/**
 * Downstream Hub OIDC relying party (review H2).
 *
 * The negative cases are the point of this file. A relying party that accepts a
 * token it should not is how federated login turns into an authentication bypass,
 * and this is the code the pentest will attack hardest.
 *
 * Env is set before the imports below, because ESM hoists them and config.ts is
 * evaluated on first import.
 */
import { startMockHub, type MockHub } from './fixtures/mockHub.js';

const PORT = 5190;
process.env.HUB_ISSUER = `http://127.0.0.1:${PORT}`;
process.env.HUB_CLIENT_ID = 'mcp-gateway-test-client';
process.env.HUB_CLIENT_SECRET = 'mcp-gateway-test-secret';
process.env.HUB_SCOPES = 'openid email profile groups';

const { afterAll, beforeAll, beforeEach, describe, expect, it } = await import('vitest');
const hubRp = await import('../src/auth/hub.js');
const { cfg } = await import('../src/core/config.js');

let hub: MockHub;
const NONCE = 'test-nonce-value';
const VERIFIER = 'test-code-verifier-value';

beforeAll(async () => {
  hub = await startMockHub(PORT);
});

afterAll(async () => {
  await new Promise<void>((resolve) => hub.server.close(() => resolve()));
});

beforeEach(() => {
  hub.reset();
  hubRp.resetCache();
});

// ---------------------------------------------------------------------------
describe('configuration', () => {
  it('treats the Hub as the primary login path once issuer and credentials are set', () => {
    expect(cfg.hubEnabled).toBe(true);
  });

  it('derives the redirect URI that must be registered with the Hub', () => {
    expect(cfg.hubRedirectUri).toBe('https://mcp.test.local/authorize/hub/callback');
  });
});

// ---------------------------------------------------------------------------
describe('discovery', () => {
  it('reads the Hub metadata and caches it', async () => {
    const meta = await hubRp.metadata();
    expect(meta.issuer).toBe(hub.issuer);
    expect(meta.token_endpoint).toBe(`${hub.issuer}/oauth2/token`);
    expect(meta.jwks_uri).toBe(`${hub.issuer}/oauth2/jwks`);
  });

  it('REFUSES metadata whose issuer does not match the configured one', async () => {
    // This is the guard that stops a hijacked discovery endpoint from pointing us
    // at an attacker-controlled authorization server.
    hub.options.declaredIssuer = 'https://evil.example';
    await expect(hubRp.metadata()).rejects.toMatchObject({ reason: 'discovery_failed' });
  });

  it('builds an authorization URL with S256 PKCE, state and nonce', async () => {
    const url = new URL(await hubRp.authorizationUrl({ state: 'st', nonce: 'no', codeVerifier: VERIFIER }));
    expect(url.origin + url.pathname).toBe(`${hub.issuer}/oauth2/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(hub.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.hubRedirectUri);
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge must be the hash, never the verifier itself.
    expect(url.searchParams.get('code_challenge')).not.toBe(VERIFIER);
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.searchParams.get('scope')).toContain('openid');
  });
});

// ---------------------------------------------------------------------------
describe('code exchange and ID token validation', () => {
  it('accepts a well-formed token and returns the identity', async () => {
    hub.options.nonce = NONCE;
    const identity = await hubRp.exchangeCode('good-code', VERIFIER, NONCE);
    expect(identity.subject).toBe('hub-subject-0001');
    expect(identity.email).toBe('someone@example.com');
    expect(identity.displayName).toBe('Jerry Hakim');
    expect(identity.groups).toContain('klip-connector-pilot');
  });

  it('sends the PKCE verifier and redirect_uri to the Hub', async () => {
    hub.options.nonce = NONCE;
    await hubRp.exchangeCode('good-code', VERIFIER, NONCE);
    const sent = hub.tokenRequests[0];
    expect(sent?.grant_type).toBe('authorization_code');
    expect(sent?.code).toBe('good-code');
    expect(sent?.code_verifier).toBe(VERIFIER);
    expect(sent?.redirect_uri).toBe(cfg.hubRedirectUri);
  });

  it('REFUSES a token signed by a key outside the Hub JWKS', async () => {
    hub.options.nonce = NONCE;
    hub.options.signWithForeignKey = true;
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('REFUSES a token whose issuer is not the Hub', async () => {
    hub.options.nonce = NONCE;
    hub.options.tokenIssuer = 'https://evil.example';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('REFUSES a token minted for a different client (audience binding)', async () => {
    hub.options.nonce = NONCE;
    hub.options.tokenAudience = 'some-other-application';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('REFUSES an expired token', async () => {
    hub.options.nonce = NONCE;
    hub.options.expiresInSeconds = -120;
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('REFUSES a token with no nonce at all', async () => {
    // Omitting the nonce entirely must not be treated as "no nonce required".
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('REFUSES a replayed token whose nonce belongs to a different sign-in', async () => {
    hub.options.nonce = 'nonce-from-an-earlier-attempt';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('reports a token-endpoint rejection without leaking the Hub response body', async () => {
    hub.options.tokenError = 'invalid_grant';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({
      reason: 'token_exchange_failed',
    });
  });

  it('REFUSES a response with no id_token', async () => {
    hub.options.omitIdToken = true;
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('REFUSES a token with no email claim, since the pilot list is keyed on email', async () => {
    hub.options.nonce = NONCE;
    hub.options.claims = { email: undefined, name: 'No Email' };
    // Explicitly delete rather than set undefined, which SignJWT would drop anyway.
    hub.options.claims = { email: '' };
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('lower-cases the email so pilot-list matching is case-insensitive', async () => {
    hub.options.nonce = NONCE;
    hub.options.claims = { email: 'Someone.Mixed@Example.COM' };
    const identity = await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(identity.email).toBe('someone.mixed@example.com');
  });

  it('reads a space-delimited groups claim as well as an array', async () => {
    hub.options.nonce = NONCE;
    hub.options.claims = { groups: 'alpha beta gamma' };
    const identity = await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(identity.groups).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ---------------------------------------------------------------------------
describe('probe', () => {
  it('reports the issuer when the Hub is reachable', async () => {
    const result = await hubRp.probe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe(hub.issuer);
  });

  it('reports a failure instead of throwing, so /healthz stays serviceable', async () => {
    hub.options.declaredIssuer = 'https://evil.example';
    const result = await hubRp.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('does not match');
  });
});

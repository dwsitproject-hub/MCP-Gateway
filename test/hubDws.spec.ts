/**
 * DWS Hub, modelled exactly as documented in SSO-TARGET-APP-INTEGRATION.md.
 *
 * Every setting below is a real deviation from the OIDC defaults my first
 * implementation assumed, and three of them would have failed outright:
 *
 *   - endpoints live under /api/sso, so the discovery document is NOT at the
 *     RFC 8414 path derived from the issuer
 *   - it is a PUBLIC client: token_endpoint_auth_methods_supported = ["none"],
 *     and no client_secret exists at all
 *   - the token endpoint requires a JSON body and answers
 *     `unsupported_grant_type` to a form-encoded one
 *   - only openid / profile / email are advertised; there is no groups claim
 */
import { startMockHub, type MockHub } from './fixtures/mockHub.js';

const PORT = 5194;
const HUB = `http://127.0.0.1:${PORT}`;

process.env.HUB_ISSUER = HUB;
process.env.HUB_DISCOVERY_URL = `${HUB}/api/sso/.well-known/openid-configuration`;
process.env.HUB_CLIENT_ID = 'mcp-gw';
delete process.env.HUB_CLIENT_SECRET; // public client - there is no secret
process.env.HUB_SCOPES = 'openid email profile';
delete process.env.HUB_REQUIRED_GROUP;

const { afterAll, beforeAll, beforeEach, describe, expect, it } = await import('vitest');
const hubRp = await import('../src/auth/hub.js');
const { cfg } = await import('../src/core/config.js');

let hub: MockHub;
const NONCE = 'dws-nonce';
const VERIFIER = 'dws-code-verifier';

beforeAll(async () => {
  hub = await startMockHub(PORT, {
    clientId: 'mcp-gw',
    pathPrefix: '/api/sso',
    requireJsonBody: true,
    advertisedTokenAuthMethods: ['none'],
    advertisedScopes: ['openid', 'profile', 'email'],
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => hub.server.close(() => resolve()));
});
beforeEach(() => {
  // reset() clears scenario options, so re-apply the Hub's fixed character.
  hub.reset();
  hub.options.pathPrefix = '/api/sso';
  hub.options.requireJsonBody = true;
  hub.options.advertisedTokenAuthMethods = ['none'];
  hub.options.advertisedScopes = ['openid', 'profile', 'email'];
  hub.options.nonce = NONCE;
  hubRp.resetCache();
});

describe('configuration', () => {
  it('treats the Hub as enabled without any client secret', () => {
    expect(cfg.hubEnabled).toBe(true);
    expect(cfg.HUB_CLIENT_SECRET).toBeUndefined();
  });

  it('uses the explicit /api/sso discovery URL, not the derived one', () => {
    expect(cfg.hubDiscoveryUrl).toBe(`${HUB}/api/sso/.well-known/openid-configuration`);
    expect(cfg.hubDiscoveryUrl).not.toBe(`${HUB}/.well-known/openid-configuration`);
  });
});

describe('discovery under a path prefix', () => {
  it('reads the document and the /api/sso endpoints from it', async () => {
    const meta = await hubRp.metadata();
    expect(meta.issuer).toBe(HUB);
    expect(meta.authorization_endpoint).toBe(`${HUB}/api/sso/authorize`);
    expect(meta.token_endpoint).toBe(`${HUB}/api/sso/token`);
    expect(meta.jwks_uri).toBe(`${HUB}/api/sso/jwks`);
  });

  it('still enforces the issuer match against the document', async () => {
    hub.options.declaredIssuer = 'https://evil.example';
    await expect(hubRp.metadata()).rejects.toMatchObject({ reason: 'discovery_failed' });
  });

  it('selects the public-client auth method from the advertised ["none"]', async () => {
    const meta = await hubRp.metadata();
    expect(hubRp.tokenAuthMethod(meta)).toBe('none');
  });
});

describe('token exchange against a public client that demands JSON', () => {
  it('completes the exchange and returns the identity', async () => {
    const identity = await hubRp.exchangeCode('a-code', VERIFIER, NONCE);
    expect(identity.subject).toBe('hub-subject-0001');
    expect(identity.email).toBe('someone@example.com');
  });

  it('sends a JSON body — a form-encoded one would be unsupported_grant_type', async () => {
    await hubRp.exchangeCode('a-code', VERIFIER, NONCE);
    expect(hub.observedTokenBody).toBe('json');
  });

  it('sends NO client_secret and no Authorization header', async () => {
    await hubRp.exchangeCode('a-code', VERIFIER, NONCE);
    expect(hub.observedTokenAuth).toBe('none');
    expect(hub.tokenRequests[0]?.client_secret).toBeUndefined();
  });

  it('sends client_id, redirect_uri and code_verifier, all of which the Hub requires', async () => {
    await hubRp.exchangeCode('a-code', VERIFIER, NONCE);
    const sent = hub.tokenRequests[0];
    expect(sent?.client_id).toBe('mcp-gw');
    expect(sent?.redirect_uri).toBe(cfg.hubRedirectUri);
    expect(sent?.code_verifier).toBe(VERIFIER);
    expect(sent?.grant_type).toBe('authorization_code');
  });

  it('falls back to form encoding when a Hub rejects JSON, and still succeeds', async () => {
    // The documented Hub is the other way round, but the fallback must not be
    // one-directional: a provider that only accepts form encoding has to work too.
    hub.options.requireJsonBody = false;
    hub.options.requireFormBody = true;

    const identity = await hubRp.exchangeCode('a-code', VERIFIER, NONCE);

    expect(identity.email).toBe('someone@example.com');
    expect(hub.observedTokenBody).toBe('form');
    // Two attempts: JSON first (rejected), then form.
    expect(hub.tokenRequests).toHaveLength(2);
  });

  it('reports both attempts when neither encoding is accepted', async () => {
    hub.options.requireJsonBody = true;
    hub.options.requireFormBody = true;   // impossible to satisfy
    await expect(hubRp.exchangeCode('a-code', VERIFIER, NONCE)).rejects.toThrow(/both json and form/i);
  });

});

describe('authorization request', () => {
  it('points the browser at the /api/sso authorize endpoint with S256 PKCE', async () => {
    const url = new URL(await hubRp.authorizationUrl({ state: 's', nonce: 'n', codeVerifier: VERIFIER }));
    expect(url.origin + url.pathname).toBe(`${HUB}/api/sso/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe('mcp-gw');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.hubRedirectUri);
    // No groups: the Hub does not advertise it and would not issue the claim.
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('requests only scopes the Hub advertises', async () => {
    const meta = await hubRp.metadata();
    const advertised = (meta as unknown as { scopes_supported?: string[] }).scopes_supported ?? [];
    for (const scope of cfg.HUB_SCOPES.split(/\s+/).filter(Boolean)) {
      expect(advertised).toContain(scope);
    }
  });
});

describe('id_token validation is unchanged by any of this', () => {
  it('still refuses a token signed outside the Hub JWKS', async () => {
    hub.options.signWithForeignKey = true;
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('still refuses a replayed nonce', async () => {
    hub.options.nonce = 'a-different-sign-in';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });

  it('still refuses a token minted for another client', async () => {
    hub.options.tokenAudience = 'some-other-app';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'id_token_invalid' });
  });
});

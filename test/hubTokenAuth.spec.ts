/**
 * Token-endpoint client authentication method.
 *
 * This was hardcoded to `client_secret_basic`. Against a Hub that only accepts
 * `client_secret_post` that fails with a 401 that reads exactly like bad
 * credentials — the worst kind of integration bug, because the obvious response is
 * to go and re-check the secret.
 *
 * It is now read from `token_endpoint_auth_methods_supported` in discovery, with
 * `HUB_TOKEN_AUTH_METHOD` as an override for a Hub whose metadata is incomplete.
 * The mock enforces one method strictly, so the relying party's choice is really
 * exercised rather than merely inspected.
 */
import { startMockHub, type MockHub } from './fixtures/mockHub.js';

const PORT = 5193;
process.env.HUB_ISSUER = `http://127.0.0.1:${PORT}`;
process.env.HUB_CLIENT_ID = 'mcp-gw';
process.env.HUB_CLIENT_SECRET = 'test-dwshub-secret';

const { afterAll, beforeAll, beforeEach, describe, expect, it } = await import('vitest');
const hubRp = await import('../src/auth/hub.js');

let hub: MockHub;
const NONCE = 'auth-method-nonce';
const VERIFIER = 'auth-method-verifier';

beforeAll(async () => {
  hub = await startMockHub(PORT, { clientId: 'mcp-gw' });
});
afterAll(async () => {
  await new Promise<void>((resolve) => hub.server.close(() => resolve()));
});
beforeEach(() => {
  hub.reset();
  hubRp.resetCache();
  hub.options.nonce = NONCE;
});

describe('choosing the method from discovery', () => {
  it('defaults to client_secret_basic when the Hub advertises nothing (RFC 8414 default)', async () => {
    await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(hub.observedTokenAuth).toBe('client_secret_basic');
  });

  it('uses client_secret_basic when the Hub advertises both', async () => {
    hub.options.advertisedTokenAuthMethods = ['client_secret_post', 'client_secret_basic'];
    await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(hub.observedTokenAuth).toBe('client_secret_basic');
  });

  it('uses client_secret_post when that is the ONLY method the Hub accepts', async () => {
    // The exact scenario the hardcoded version could not survive.
    hub.options.advertisedTokenAuthMethods = ['client_secret_post'];
    hub.options.requireTokenAuthMethod = 'client_secret_post';
    const identity = await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(hub.observedTokenAuth).toBe('client_secret_post');
    expect(identity.email).toBe('someone@example.com');
  });

  it('sends the secret in the body, not a header, when using client_secret_post', async () => {
    hub.options.advertisedTokenAuthMethods = ['client_secret_post'];
    await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(hub.tokenRequests[0]?.client_secret).toBe('test-dwshub-secret');
    expect(hub.tokenRequests[0]?.client_id).toBe('mcp-gw');
  });

  it('does NOT put the secret in the body when using client_secret_basic', async () => {
    hub.options.advertisedTokenAuthMethods = ['client_secret_basic'];
    await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(hub.tokenRequests[0]?.client_secret).toBeUndefined();
  });

  it('falls back to basic, with a warning, for an exotic advertised set', async () => {
    hub.options.advertisedTokenAuthMethods = ['private_key_jwt', 'tls_client_auth'];
    await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(hub.observedTokenAuth).toBe('client_secret_basic');
  });
});

describe('when the method is wrong', () => {
  it('names the method in the error, instead of implying bad credentials', async () => {
    // The Hub demands post; discovery claims basic is fine. Without the method in
    // the message this looks like a wrong client secret.
    hub.options.advertisedTokenAuthMethods = ['client_secret_basic'];
    hub.options.requireTokenAuthMethod = 'client_secret_post';

    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({
      reason: 'token_exchange_failed',
    });
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toThrow(/client_secret_basic/);
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toThrow(/HUB_TOKEN_AUTH_METHOD/);
  });
});

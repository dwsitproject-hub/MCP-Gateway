/**
 * HUB_REQUIRE_NONCE=false: accepting a Hub that never echoes the nonce.
 *
 * The production DWS Hub returned an ID token with no nonce claim, and the first
 * sign-in failed with "the Hub identity token nonce did not match this sign-in
 * attempt" - a message that reads like an attack and was in fact a missing feature.
 * ABSENT and WRONG were reported identically, so the message sent us looking in the
 * wrong place.
 *
 * They are now separate, because the correct response differs:
 *
 *   absent   the provider ignored the parameter. Non-conformant (OIDC Core 3.1.3.7
 *            says a nonce that was SENT must come back), but a defence that is
 *            missing rather than broken - and the code flow still has PKCE S256 and
 *            a single-use state. Configurable.
 *   wrong    this ID token belongs to a DIFFERENT sign-in. Never configurable.
 *
 * The second test is the one that matters: it proves the escape hatch does not widen
 * into "skip the nonce check". Strict-by-default is covered in hub.spec.ts.
 */
import { startMockHub, type MockHub } from './fixtures/mockHub.js';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.hubNonce;
const HUB = `http://127.0.0.1:${PORT}`;

process.env.HUB_ISSUER = HUB;
process.env.HUB_DISCOVERY_URL = `${HUB}/api/sso/.well-known/openid-configuration`;
process.env.HUB_CLIENT_ID = 'mc-gw';
delete process.env.HUB_CLIENT_SECRET;
process.env.HUB_REQUIRE_NONCE = 'false';

const { afterAll, beforeAll, beforeEach, describe, expect, it } = await import('vitest');
const hubRp = await import('../src/auth/hub.js');

let hub: MockHub;
const NONCE = 'the-nonce-we-sent';
const VERIFIER = 'nonce-spec-code-verifier';

beforeAll(async () => {
  // Shaped like the real DWS Hub: endpoints under /api/sso, public client, JSON body.
  hub = await startMockHub(PORT, {
    clientId: 'mc-gw',
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
  hub.options.clientId = 'mc-gw';
  hub.options.pathPrefix = '/api/sso';
  hub.options.requireJsonBody = true;
  hub.options.advertisedTokenAuthMethods = ['none'];
});

describe('a Hub that never echoes the nonce', () => {
  it('is accepted when HUB_REQUIRE_NONCE=false', async () => {
    // The mock omits the claim unless options.nonce is set, which is exactly what the
    // production Hub does.
    const identity = await hubRp.exchangeCode('good-code', VERIFIER, NONCE);
    expect(identity.subject).toBeDefined();
    expect(identity.email).toBeDefined();
  });

  it('still refuses a nonce belonging to a DIFFERENT sign-in', async () => {
    // The whole point of the flag. Relaxing "absent" must not relax "wrong": an
    // attacker replaying someone else's ID token supplies a nonce, just not ours.
    hub.options.nonce = 'a-nonce-from-somebody-elses-login';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({
      reason: 'id_token_invalid',
    });
  });

  it('names the mismatch as such, so it is not mistaken for the missing-nonce case', async () => {
    hub.options.nonce = 'a-nonce-from-somebody-elses-login';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toThrow(/DIFFERENT sign-in attempt/);
  });

  it('accepts the matching nonce when the Hub does send one', async () => {
    hub.options.nonce = NONCE;
    const identity = await hubRp.exchangeCode('good-code', VERIFIER, NONCE);
    expect(identity.subject).toBeDefined();
  });

  it('keeps every other ID token check intact', async () => {
    // A relaxed nonce must not become a relaxed anything-else. Signature, issuer and
    // audience are all still refused.
    hub.options.signWithForeignKey = true;
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({
      reason: 'id_token_invalid',
    });
    hub.reset();
    hub.options.requireJsonBody = true;

    hub.options.tokenAudience = 'some-other-application';
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({
      reason: 'id_token_invalid',
    });
  });
});

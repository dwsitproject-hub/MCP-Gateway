/**
 * Loopback redirect URIs for a local app (RFC 8252), e.g. Milo's agents.
 *
 * The rule: an admin may pre-register a client whose redirect is http://127.0.0.1:<port>
 * when ALLOW_LOOPBACK_REDIRECTS is on. Dynamic registration - the public /register
 * endpoint - never accepts one, so nobody on the internet can mint a loopback client.
 */
import { describe, expect, it } from 'vitest';
import { clientsStore, isAllowedRedirectUri } from '../src/auth/clients.js';
import { cfg } from '../src/core/config.js';

const MILO = 'http://127.0.0.1:4242/api/gateway/callback';

describe('isAllowedRedirectUri - loopback', () => {
  it('is off by default', () => {
    expect(cfg.ALLOW_LOOPBACK_REDIRECTS).toBe(false);
    expect(isAllowedRedirectUri(MILO)).toBe(false);
  });

  it('accepts http on the literal 127.0.0.1, any port, when enabled', () => {
    expect(isAllowedRedirectUri(MILO, { loopback: true })).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:51234/cb', { loopback: true })).toBe(true);
  });

  it('refuses names and look-alikes even when enabled', () => {
    for (const uri of [
      'http://localhost:4242/cb',            // a name can resolve elsewhere (RFC 8252 8.3)
      'http://127.0.0.1.evil.com/cb',
      'http://evil.com@127.0.0.1/cb',        // userinfo
      'http://127.0.0.1:4242/cb#frag',
      'http://127.0.0.2/cb',
      'http://[::1]:4242/cb',
      'http://0x7f000001/cb',              // the parser normalises this to 127.0.0.1
      'http://2130706433/cb',
      'ftp://127.0.0.1/cb',
    ]) {
      expect(isAllowedRedirectUri(uri, { loopback: true }), uri).toBe(false);
    }
  });

  it('leaves the https rule for claude.ai unchanged', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', { loopback: true })).toBe(true);
    expect(isAllowedRedirectUri('http://claude.ai/api/mcp/auth_callback', { loopback: true })).toBe(false);
  });
});

describe('dynamic registration never accepts loopback', () => {
  it('rejects a loopback redirect at /register before touching the database', async () => {
    await expect(
      clientsStore.registerClient!({ client_name: 'Milo - Atlas', redirect_uris: [MILO] } as never),
    ).rejects.toThrow(/redirect_uris must be https/);
  });

  it('still rejects it with ALLOW_LOOPBACK_REDIRECTS ON - the claim is "whatever the flag says"', async () => {
    /**
     * Added in review. The test above runs with the flag at its default of false, so it
     * proves /register refuses loopback when the feature is OFF - which nobody doubted.
     * The guarantee that matters is the other half: that turning the feature on for
     * client:add does not also open the public endpoint. If registerClient were ever
     * changed to pass { loopback: cfg.ALLOW_LOOPBACK_REDIRECTS }, the first test would
     * still pass and anyone on the internet could mint a loopback client. This one fails.
     */
    const mutable = cfg as { ALLOW_LOOPBACK_REDIRECTS: boolean };
    const before = mutable.ALLOW_LOOPBACK_REDIRECTS;
    mutable.ALLOW_LOOPBACK_REDIRECTS = true;
    try {
      await expect(
        clientsStore.registerClient!({ client_name: 'Milo - Atlas', redirect_uris: [MILO] } as never),
      ).rejects.toThrow(/redirect_uris must be https/);
    } finally {
      mutable.ALLOW_LOOPBACK_REDIRECTS = before;
    }
  });
});

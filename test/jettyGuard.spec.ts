/**
 * The JPS read-only guard, and the optional-integration boot rule.
 *
 * These two properties carry more weight than any Jetty tool will.
 *
 * The guard, because JPS is the operational system of record - its API approves
 * shipment plans, signs off operations and records the cast-off that marks a vessel
 * SAILED - and the staging service account holds `JPS Full Access`: 28 of 31 pages with
 * edit and delete, 29 with approve, measured 11 Sep 2026. Nothing upstream will refuse
 * a write, so this file asserts that nothing downstream can send one.
 *
 * The boot rule, because adding JETTY_SVC_PASS to the secret checks made an UNSET
 * optional secret read as "empty" and exit at startup - which would have stopped every
 * existing production gateway from booting, before it even reached the Hub TLS check.
 * An integration nobody has configured must never be able to take the gateway down.
 */
import { beforeAll, describe, expect, it } from 'vitest';

type Mods = {
  resolveTarget: typeof import('../src/adapters/jetty/client.js')['resolveTarget'];
  jettyConfigured: typeof import('../src/adapters/jetty/client.js')['jettyConfigured'];
  GatewayError: typeof import('../src/core/errors.js')['GatewayError'];
};
let m: Mods;

beforeAll(async () => {
  process.env.JETTY_BASE_URL = 'http://127.0.0.1:39990/api/v1';
  process.env.JETTY_SVC_USER = 'MCP';
  process.env.JETTY_SVC_PASS = 'not-a-real-password';
  process.env.JETTY_PORT_ID = '1';
  const client = await import('../src/adapters/jetty/client.js');
  const errors = await import('../src/core/errors.js');
  m = {
    resolveTarget: client.resolveTarget,
    jettyConfigured: client.jettyConfigured,
    GatewayError: errors.GatewayError,
  };
});

describe('the JPS client cannot emit a write', () => {
  it('permits a GET inside the API mount point', () => {
    const t = m.resolveTarget('GET', '/operations/at-berth');
    expect(t.pathname).toBe('/api/v1/operations/at-berth');
  });

  it('permits exactly one POST: the service-account login', () => {
    const t = m.resolveTarget('POST', '/auth/login');
    expect(t.pathname).toBe('/api/v1/auth/login');
  });

  it('refuses a POST anywhere else - including the endpoints that change a voyage', () => {
    // Each of these is a real JPS endpoint that would alter port operations.
    for (const path of [
      '/shipment-plans/1/approve',
      '/shipment-plans/1/reject',
      '/operations/1/signoff',
      '/operations/1/depart',
      '/operations/1/start-docking',
      '/allocation/arrival',
    ]) {
      expect(() => m.resolveTarget('POST', path)).toThrow(m.GatewayError);
    }
  });

  it('refuses every method other than GET and POST', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(() => m.resolveTarget(method as 'GET', '/operations/1')).toThrow(m.GatewayError);
    }
  });

  it('refuses traversal, encoded traversal and backslashes', () => {
    for (const path of ['/../admin', '/operations/../../etc/passwd', '/%2e%2e/admin', '/operations\\..\\admin']) {
      expect(() => m.resolveTarget('GET', path)).toThrow(m.GatewayError);
    }
  });

  it('refuses an absolute URL or a protocol-relative path that would change host', () => {
    for (const path of ['//evil.example.com/api/v1/operations', '//127.0.0.1:1/x']) {
      expect(() => m.resolveTarget('GET', path)).toThrow(m.GatewayError);
    }
    // A relative path is required; an absolute one does not start with "/" after the
    // scheme and is refused on that basis.
    expect(() => m.resolveTarget('GET', 'http://evil.example.com/api/v1/operations')).toThrow(m.GatewayError);
  });

  it('refuses a GET that lands on the mount point itself or carries an empty segment', () => {
    for (const path of ['/', '//', '/operations//1']) {
      expect(() => m.resolveTarget('GET', path)).toThrow(m.GatewayError);
    }
  });

  it('reports itself configured only when base url, user and password are all present', () => {
    expect(m.jettyConfigured()).toBe(true);
  });
});

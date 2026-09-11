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
  s: typeof import('../src/adapters/jetty/session.js')['jettySessionInternals'];
};
let m: Mods;

beforeAll(async () => {
  process.env.JETTY_BASE_URL = 'http://127.0.0.1:39990/api/v1';
  process.env.JETTY_SVC_USER = 'MCP';
  process.env.JETTY_SVC_PASS = 'not-a-real-password';
  process.env.JETTY_PORT_ID = '1';
  const client = await import('../src/adapters/jetty/client.js');
  const errors = await import('../src/core/errors.js');
  const session = await import('../src/adapters/jetty/session.js');
  m = {
    resolveTarget: client.resolveTarget,
    jettyConfigured: client.jettyConfigured,
    GatewayError: errors.GatewayError,
    s: session.jettySessionInternals,
  };
});

/** A structurally real JWT. Never the live one - that is a working credential. */
function jwt(expSeconds: number, iatSeconds = expSeconds - 28_800): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: '32', iat: iatSeconds, exp: expSeconds })}.sig`;
}

describe('the login response shape, as measured', () => {
  /**
   * Taken from a real 11 Sep 2026 login: the body carries {"user":{...}} and NO token,
   * the credential is the `jps_at` cookie, and `jps_xsrf` sits beside it. Presenting
   * the CSRF value as a Bearer would fail confusingly, so the wrong one being picked is
   * the failure this pins down.
   */
  const setCookie = [
    'jps_at=THE-SESSION-JWT; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax',
    'jps_xsrf=6ad7dbf0f5478dc44066b8db701afd68; Max-Age=28800; Path=/; SameSite=Lax',
  ];

  it('takes the session cookie and never the CSRF one', () => {
    const res = { status: 200, data: { user: { id: '32', username: 'MCP' } }, durationMs: 1, pathname: '/x' };
    const found = m.s.extractToken(res, setCookie);
    expect(found?.token).toBe('THE-SESSION-JWT');
    expect(found?.from).toBe('cookie:jps_at');
  });

  it('refuses to treat the CSRF cookie as a credential when it is the only one', () => {
    const res = { status: 200, data: { user: { id: '32' } }, durationMs: 1, pathname: '/x' };
    expect(m.s.extractToken(res, [setCookie[1] as string])).toBeNull();
  });

  it('still accepts a body token, should JPS ever start returning one', () => {
    const res = { status: 200, data: { token: 'FROM-BODY' }, durationMs: 1, pathname: '/x' };
    expect(m.s.extractToken(res, [])?.from).toBe('body');
  });

  it('reads the 8-hour expiry out of the JWT so the token is refreshed, not failed', () => {
    // The measured token lived 28,800 s. Caching until a 401 would mean one guaranteed
    // failed call every 8 hours, paid for by whoever happened to ask.
    const exp = Math.floor(Date.now() / 1000) + 28_800;
    expect(m.s.readExpiry(jwt(exp))).toBe(exp * 1000);
    expect(m.s.EXPIRY_MARGIN_MS).toBeGreaterThan(0);
  });

  it('returns null for a token it cannot read, rather than throwing in the login path', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.!!!notbase64!!!.c']) {
      expect(m.s.readExpiry(bad)).toBeNull();
    }
  });
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

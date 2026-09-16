/**
 * The pilot-list admin UI, at /admin on the PUBLIC host.
 *
 * This page grants read access to production commercial data, and it sits on a host we
 * watched take continuous /admin and boaform/admin/formLogin probes while building it.
 * So the tests here are not about the form working - they are about the four ways in
 * that must stay shut:
 *
 *   1. no session            -> handed to Downstream Hub, never a local login form
 *   2. session but not admin -> refused, and refused again on the NEXT request after
 *                               the flag is revoked, not when the cookie expires
 *   3. forged session        -> a cookie we did not sign buys nothing
 *   4. no CSRF token         -> a POST from anywhere else changes nothing
 *
 * The admin flag itself is granted only from the CLI. There is deliberately no route
 * here that can create one, which is the property test five pins.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.adminUi;

process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
process.env.HUB_ISSUER = 'https://hub.test.example';
process.env.HUB_CLIENT_ID = 'mc-gw';

/** The users table, as these tests pose it. */
interface Row {
  id: string;
  email: string;
  is_admin: boolean;
  is_break_glass: boolean;
  disabled_at: Date | null;
  auth_source: string;
  hub_subject: string | null;
  display_name: string | null;
  last_login_at: Date | null;
}

let table: Row[] = [];
const writes: string[] = [];

function user(email: string, o: Partial<Row> = {}): Row {
  return {
    id: `id-${email}`,
    email,
    is_admin: false,
    is_break_glass: false,
    disabled_at: null,
    auth_source: 'hub',
    hub_subject: 'sub-1',
    display_name: null,
    last_login_at: null,
    ...o,
  };
}

vi.mock('../src/core/db.js', () => ({
  query: async (sql: string, params: readonly unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('SELECT * FROM users WHERE lower(email)')) {
      return table.filter((r) => r.email.toLowerCase() === String(params[0]).toLowerCase());
    }
    if (sql.includes('FROM users ORDER BY')) return table;
    if (sql.startsWith('UPDATE') || sql.startsWith('INSERT') || sql.startsWith('DELETE')) writes.push(sql);
    return [];
  },
  queryOne: async (sql: string, params: readonly unknown[] = []): Promise<unknown> => {
    if (sql.includes('SELECT * FROM users WHERE lower(email)')) {
      return table.find((r) => r.email.toLowerCase() === String(params[0]).toLowerCase());
    }
    return undefined;
  },
  isReachable: async (): Promise<boolean> => true,
}));

vi.mock('../src/core/audit.js', () => ({
  write: async (): Promise<void> => undefined,
  newRequestId: (): string => 'req-test',
  auditStore: { isHealthy: () => true, queueDepth: () => 0 },
}));

// Only the two calls the router makes. The round trip itself is covered in hub.spec.ts
// and hubNonce.spec.ts; what matters here is that an anonymous visitor is sent OUT to
// the Hub rather than shown anything local.
vi.mock('../src/auth/hub.js', () => ({
  beginRoundTrip: async (): Promise<{ state: string; nonce: string; codeVerifier: string }> => ({
    state: 'st',
    nonce: 'no',
    codeVerifier: 'cv',
  }),
  authorizationUrl: async (): Promise<string> =>
    'https://hub.test.example/api/sso/authorize?client_id=mc-gw&state=st',
}));

vi.mock('../src/auth/tokens.js', () => ({
  revokeUser: async (): Promise<void> => {
    writes.push('REVOKE');
  },
}));

const { adminRouter } = await import('../src/http/admin.js');
const { issueAdminSession, ADMIN_SESSION_COOKIE } = await import('../src/auth/adminSession.js');

let server: Server;
const base = (): string => `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(adminRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(PORT, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  table = [user('boss@example.com', { is_admin: true }), user('pilot@example.com')];
  writes.length = 0;
});

/** A session cookie for someone, signed by the real signer. */
async function cookieFor(email: string): Promise<string> {
  const token = await issueAdminSession(`id-${email}`, email);
  return `${ADMIN_SESSION_COOKIE}=${token}`;
}

/** Pull the CSRF value the page rendered, the way a browser's form would. */
async function csrfFrom(cookie: string): Promise<string> {
  const res = await fetch(`${base()}/admin`, { headers: { cookie } });
  const html = await res.text();
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (m?.[1] === undefined) throw new Error('no CSRF token on the page');
  return m[1];
}

describe('reaching the page', () => {
  it('sends an anonymous visitor to Downstream Hub, and shows no login form', async () => {
    const res = await fetch(`${base()}/admin`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    // Off to the Hub. A local password box on an internet-facing admin page would be
    // a credential-stuffing target, and there is deliberately not one.
    expect(res.headers.get('location') ?? '').toContain('hub.test.example');
  });

  it('renders the list for an administrator', async () => {
    const html = await (await fetch(`${base()}/admin`, { headers: { cookie: await cookieFor('boss@example.com') } })).text();
    expect(html).toContain('pilot@example.com');
    expect(html).toContain('Add someone to the pilot');
  });

  it('REFUSES a pilot user who is not an administrator', async () => {
    const res = await fetch(`${base()}/admin`, { headers: { cookie: await cookieFor('pilot@example.com') } });
    expect(res.status).toBe(403);
  });

  it('REFUSES a forged session cookie', async () => {
    // Not signed by us: readAdminSession returns undefined, so this is treated as
    // anonymous and bounced to the Hub rather than admitted.
    const res = await fetch(`${base()}/admin`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=not.a.real.token` },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('stops working the moment the admin flag is revoked, not when the cookie expires', async () => {
    const cookie = await cookieFor('boss@example.com');
    expect((await fetch(`${base()}/admin`, { headers: { cookie } })).status).toBe(200);

    // Same still-valid cookie, flag taken away. is_admin is re-read per request.
    table = table.map((r) => (r.email === 'boss@example.com' ? { ...r, is_admin: false } : r));
    expect((await fetch(`${base()}/admin`, { headers: { cookie } })).status).toBe(403);
  });

  it('REFUSES a disabled administrator', async () => {
    const cookie = await cookieFor('boss@example.com');
    table = table.map((r) => (r.email === 'boss@example.com' ? { ...r, disabled_at: new Date() } : r));
    expect((await fetch(`${base()}/admin`, { headers: { cookie } })).status).toBe(403);
  });
});

describe('adding someone', () => {
  it('writes the user when the CSRF token matches', async () => {
    const cookie = await cookieFor('boss@example.com');
    const csrf = await csrfFrom(cookie);
    const res = await fetch(`${base()}/admin/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, email: 'new@example.com', display_name: 'New Person' }),
    });
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.includes('INSERT INTO users'))).toBe(true);
  });

  it('WRITES NOTHING without a CSRF token', async () => {
    // The cross-site case: the attacker has the victim's cookie riding along on a form
    // POST from their own page, but cannot read the token out of our HTML.
    const cookie = await cookieFor('boss@example.com');
    const res = await fetch(`${base()}/admin/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'attacker@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('WRITES NOTHING with another session’s CSRF token', async () => {
    const victim = await cookieFor('boss@example.com');
    const attackerToken = await csrfFrom(await cookieFor('boss@example.com')); // a different session
    const res = await fetch(`${base()}/admin/users`, {
      method: 'POST',
      headers: { cookie: victim, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: attackerToken, email: 'attacker@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('rejects a malformed address rather than creating an account nobody can sign into', async () => {
    const cookie = await cookieFor('boss@example.com');
    const csrf = await csrfFrom(cookie);
    const res = await fetch(`${base()}/admin/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe('what the UI must never be able to do', () => {
  it('exposes NO route that grants administrator rights', async () => {
    // The whole safety argument rests on this: /admin can add pilot USERS, but only a
    // shell on the host can create an ADMIN. If a route ever appears that flips
    // is_admin, the public page becomes self-service and this test should fail.
    const cookie = await cookieFor('boss@example.com');
    const csrf = await csrfFrom(cookie);
    for (const path of ['/admin/users/grant-admin', '/admin/admins', '/admin/users/admin']) {
      const res = await fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, email: 'pilot@example.com' }),
      });
      expect(res.status).toBe(404);
    }
    expect(writes.some((w) => w.includes('is_admin'))).toBe(false);
  });

  it('refuses to disable the break-glass account', async () => {
    table.push(user('breakglass@example.com', { is_break_glass: true, auth_source: 'local' }));
    const cookie = await cookieFor('boss@example.com');
    const csrf = await csrfFrom(cookie);
    const res = await fetch(`${base()}/admin/users/disable`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, email: 'breakglass@example.com' }),
    });
    // Reached through the Hub; disabling the way back in when the Hub is down could
    // only be undone from a shell.
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('refuses to disable the signed-in administrator', async () => {
    const cookie = await cookieFor('boss@example.com');
    const csrf = await csrfFrom(cookie);
    const res = await fetch(`${base()}/admin/users/disable`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, email: 'boss@example.com' }),
    });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('revokes the tokens of anyone it disables', async () => {
    const cookie = await cookieFor('boss@example.com');
    const csrf = await csrfFrom(cookie);
    await fetch(`${base()}/admin/users/disable`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, email: 'pilot@example.com' }),
    });
    // Disabling without revoking would leave a live token reading KLIP for hours.
    expect(writes).toContain('REVOKE');
  });
});

/**
 * The Hub callback's SECOND ending: an admin sign-in rather than an OAuth code.
 *
 * This file exists because the branch that distinguishes them shipped missing. The
 * patch that added it reported success and wrote nothing, typecheck passed because the
 * unused imports were still legal, and adminUi.spec.ts could not catch it because it
 * mocks the Hub module and never touches this route. The symptom in production was
 * "Authorization request expired" - a timeout message for a bug that had nothing to do
 * with time, which is the sort of error that costs an hour.
 *
 * So the assertion that matters is the first one: the sentinel round trip must NOT
 * reach verifyPending. Everything else here guards the checks that follow it.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORTS } from './fixtures/ports.js';

const PORT = PORTS.adminCallback;

process.env.PUBLIC_URL = `http://127.0.0.1:${PORT}`;
process.env.HUB_ISSUER = 'https://hub.test.example';
process.env.HUB_CLIENT_ID = 'mc-gw';

interface Row {
  id: string;
  email: string;
  is_admin: boolean;
  is_break_glass: boolean;
  disabled_at: Date | null;
  auth_source: string;
  hub_subject: string | null;
  display_name: string | null;
  password_hash: string | null;
  failed_logins: number;
  locked_until: Date | null;
  last_login_at: Date | null;
}

let table: Row[] = [];
/** What consumeRoundTrip will hand back. The whole point of the test. */
let pendingToken = 'admin-ui';
let exchangeEmail = 'boss@example.com';

function user(email: string, o: Partial<Row> = {}): Row {
  return {
    id: `id-${email}`,
    email,
    is_admin: false,
    is_break_glass: false,
    disabled_at: null,
    auth_source: 'hub',
    hub_subject: null,
    display_name: null,
    password_hash: null,
    failed_logins: 0,
    locked_until: null,
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
    return [];
  },
  queryOne: async (sql: string, params: readonly unknown[] = []): Promise<unknown> => {
    if (sql.includes('SELECT * FROM users WHERE lower(email)')) {
      return table.find((r) => r.email.toLowerCase() === String(params[0]).toLowerCase());
    }
    if (sql.includes('FROM users WHERE hub_subject')) {
      return table.find((r) => r.hub_subject === String(params[0]));
    }
    return undefined;
  },
}));

vi.mock('../src/core/audit.js', () => ({
  write: async (): Promise<void> => undefined,
  newRequestId: (): string => 'req-test',
}));

/** Stands in for the Hub. consumeRoundTrip is what the branch reads. */
vi.mock('../src/auth/hub.js', () => ({
  HubError: class HubError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
    }
  },
  consumeRoundTrip: async (): Promise<{ pendingToken: string; codeVerifier: string; nonce: string }> => ({
    pendingToken,
    codeVerifier: 'cv',
    nonce: 'no',
  }),
  exchangeCode: async (): Promise<{ subject: string; email: string; displayName: string; groups: string[] }> => ({
    subject: 'hub-sub-1',
    email: exchangeEmail,
    displayName: 'Someone',
    groups: [],
  }),
  beginRoundTrip: async (): Promise<{ state: string; nonce: string; codeVerifier: string }> => ({
    state: 'st',
    nonce: 'no',
    codeVerifier: 'cv',
  }),
  authorizationUrl: async (): Promise<string> => 'https://hub.test.example/api/sso/authorize',
}));

const { consentRouter } = await import('../src/http/consent.js');
const { ADMIN_SESSION_COOKIE } = await import('../src/auth/adminSession.js');

let server: Server;
const callback = (): string => `http://127.0.0.1:${PORT}/authorize/hub/callback?code=abc&state=xyz`;

beforeAll(async () => {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(consentRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(PORT, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  table = [user('boss@example.com', { is_admin: true }), user('pilot@example.com')];
  pendingToken = 'admin-ui';
  exchangeEmail = 'boss@example.com';
});

describe('the admin round trip', () => {
  it('issues a session and redirects to /admin', async () => {
    const res = await fetch(callback(), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    expect(res.headers.get('set-cookie') ?? '').toContain(ADMIN_SESSION_COOKIE);
  });

  it('NEVER reports "Authorization request expired" for the sentinel', async () => {
    /**
     * The regression, stated as the user saw it. Before the branch existed, the
     * sentinel fell through to verifyPending, which cannot parse it, and the page
     * blamed a timeout. Anyone debugging that goes looking at TTLs and finds nothing
     * wrong with them.
     */
    const body = await (await fetch(callback(), { redirect: 'manual' })).text();
    expect(body).not.toContain('Authorization request expired');
  });

  it('REFUSES a pilot user who is not an administrator', async () => {
    exchangeEmail = 'pilot@example.com';
    const res = await fetch(callback(), { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Not an administrator');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('REFUSES someone the Hub knows but the pilot list does not', async () => {
    exchangeEmail = 'stranger@example.com';
    const res = await fetch(callback(), { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('not on the KLIP connector pilot list');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('REFUSES a disabled administrator', async () => {
    table = table.map((r) => (r.email === 'boss@example.com' ? { ...r, disabled_at: new Date() } : r));
    const res = await fetch(callback(), { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('the connector round trip still behaves', () => {
  it('goes to verifyPending, and fails there for a token that is not one', async () => {
    // A non-sentinel pending token must take the ORIGINAL path. If the branch were
    // ever widened to catch everything, this is what would notice.
    pendingToken = 'not-a-real-jwt';
    const body = await (await fetch(callback(), { redirect: 'manual' })).text();
    expect(body).toContain('Authorization request expired');
  });
});

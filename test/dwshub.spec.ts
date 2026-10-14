/**
 * The dwshub_* family: DWS Hub production support (Sentinel's results), read-only and
 * admin-only.
 *
 * What these pin:
 *   - the client can only GET, only inside the configured API root, only with the key;
 *   - names resolve against the Hub's own application list, never guessed;
 *   - long Sentinel analyses survive the envelope (4000, not 300 characters) but the
 *     proposed code patch never leaves the Hub;
 *   - only gateway admins see or can call the tools - the Hub keeps this data admin-only
 *     and the gateway must not widen it to every pilot user;
 *   - the envelope says "DWS Hub", not "KLIP" (the runner used to drop the system).
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BUG_RUN, KLIP_ID, MOCK_DWSHUB_KEY, createMockDwsHub, freshDwsHubState, type MockDwsHubState } from './fixtures/mockDwsHub.js';
import { PORTS } from './fixtures/ports.js';

vi.mock('../src/core/audit.js', () => ({
  write: vi.fn().mockResolvedValue(undefined),
  newRequestId: () => 'test-request',
}));
const usersByEmail: Record<string, { is_admin: boolean; disabled_at: Date | null }> = {
  'admin@example.com': { is_admin: true, disabled_at: null },
  'pilot@example.com': { is_admin: false, disabled_at: null },
  'gone@example.com': { is_admin: true, disabled_at: new Date() },
};
vi.mock('../src/auth/users.js', () => ({
  findByEmail: vi.fn(async (email: string) => usersByEmail[email]),
}));

const PORT = PORTS.dwshub;
let server: Server;
let state: MockDwsHubState;

type Mods = {
  client: typeof import('../src/adapters/dwshub/client.js');
  tools: typeof import('../src/tools/dwshub/tools.js');
  index: typeof import('../src/tools/dwshub/index.js');
  mcp: typeof import('../src/mcp/server.js');
  runner: typeof import('../src/mcp/runner.js');
};
let m: Mods;

const admin = { requestId: 'r', userId: 'admin@example.com', isAdmin: true };

async function call<S extends z.ZodRawShape>(tool: { inputShape: S; handler: (p: never, c: never) => Promise<unknown> }, args: Record<string, unknown>) {
  const parsed = z.strictObject(tool.inputShape).parse(args);
  return tool.handler(parsed as never, admin as never) as Promise<{ data: Record<string, unknown>; system?: string; maxFreeText?: number; rowCount: number }>;
}

beforeAll(async () => {
  process.env.DWSHUB_BASE_URL = `http://127.0.0.1:${PORT}/api/service/v1`;
  process.env.DWSHUB_SERVICE_KEY = MOCK_DWSHUB_KEY;
  process.env.DWSHUB_ENV = 'production';
  state = freshDwsHubState();
  await new Promise<void>((resolve) => { server = createMockDwsHub(state).listen(PORT, '127.0.0.1', () => resolve()); });
  m = {
    client: await import('../src/adapters/dwshub/client.js'),
    tools: await import('../src/tools/dwshub/tools.js'),
    index: await import('../src/tools/dwshub/index.js'),
    mcp: await import('../src/mcp/server.js'),
    runner: await import('../src/mcp/runner.js'),
  };
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { state.requests.length = 0; state.rejectKey = false; });

describe('GET-only guard', () => {
  it('allows paths inside the API root', () => {
    expect(m.client.resolveTarget('/sentinel/runs').pathname).toBe('/api/service/v1/sentinel/runs');
    expect(m.client.resolveTarget(`/sentinel/runs/${BUG_RUN}`).pathname).toBe(`/api/service/v1/sentinel/runs/${BUG_RUN}`);
  });

  it.each([
    ['traversal', '/../sentinel/runs'],
    ['encoded traversal', '/%2e%2e/admin'],
    ['encoded slash', '/sentinel%2fruns'],
    ['backslash', '/sentinel\\runs'],
    ['scheme-relative host', '//evil.example/x'],
    ['no leading slash', 'sentinel/runs'],
    ['root', '/'],
    ['empty segment', '/sentinel//runs'],
  ])('refuses %s', (_label, path) => {
    expect(() => m.client.resolveTarget(path)).toThrow();
  });

  it('is configured, and every request it sends is a GET with the service key', async () => {
    expect(m.client.dwshubConfigured()).toBe(true);
    expect(m.index.dwshubToolNames).toEqual(['dwshub_app_health', 'dwshub_sentinel_findings', 'dwshub_sentinel_detail', 'dwshub_bug_reports', 'dwshub_error_trends']);
    await call(m.tools.dwshubAppHealth, {});
    await call(m.tools.dwshubSentinelFindings, { application: 'klip', kind: 'bug_analysis' });
    await call(m.tools.dwshubSentinelDetail, { run_id: BUG_RUN });
    await call(m.tools.dwshubBugReports, { status: 'open' });
    await call(m.tools.dwshubErrorTrends, { application: 'KLIP' });
    expect(state.requests.length).toBeGreaterThan(5);
    for (const r of state.requests) {
      expect(r.method).toBe('GET');
      expect(r.auth).toBe(`Bearer ${MOCK_DWSHUB_KEY}`);
    }
  });

  it('every tool is read-only and admin-only', () => {
    for (const t of m.index.allDwsHubTools) {
      expect(t.name).toMatch(/^dwshub_/);
      expect(t.name).not.toMatch(/create|update|delete|approve|post|put|patch|write|submit|analy[sz]e_now|run_/i);
      expect(t.description).toContain('READ-ONLY');
      expect(t.readOnly).not.toBe(false);
      expect(t.adminOnly).toBe(true);
    }
  });
});

describe('tools', () => {
  it('dwshub_app_health lists every app and flags the ones needing attention', async () => {
    const out = await call(m.tools.dwshubAppHealth, {});
    expect(out.system).toBe('dwshub');
    expect(out.rowCount).toBe(3);
    expect(out.data.needs_attention).toEqual(['KLIP']);
    expect((out.data.sentinel as { sentinel_enabled: boolean }).sentinel_enabled).toBe(true);
  });

  it('resolves application names exactly first, then by a unique partial match', async () => {
    const exact = await call(m.tools.dwshubAppHealth, { application: 'klip' });
    expect((exact.data.applications as Array<{ name: string }>).map((a) => a.name)).toEqual(['KLIP']);
    await call(m.tools.dwshubSentinelFindings, { application: 'KLIP' });
    expect(state.requests.find((r) => r.path.endsWith('/sentinel/runs'))?.query.scope).toBe(KLIP_ID);
    const hub = await call(m.tools.dwshubAppHealth, { application: 'DWS Hub' });
    expect((hub.data.applications as Array<{ scope: string }>)[0]?.scope).toBe('hub');
  });

  it('an unknown or ambiguous application is an error naming the real ones', async () => {
    await expect(call(m.tools.dwshubErrorTrends, { application: 'SAP' })).rejects.toThrow(/no application called "SAP".*KLIP/);
    await expect(call(m.tools.dwshubBugReports, { application: 'KLI' })).rejects.toThrow(/more than one application/);
  });

  it('dwshub_sentinel_findings maps kinds and counts bug analyses by severity', async () => {
    const out = await call(m.tools.dwshubSentinelFindings, { kind: 'bug_analysis' });
    expect(state.requests.find((r) => r.path.endsWith('/sentinel/runs'))?.query.kind).toBe('bug');
    expect(out.data.bug_analyses_by_severity).toEqual({ high: 1 });
  });

  it('dwshub_sentinel_detail keeps the long analysis but not the patch', async () => {
    const out = await call(m.tools.dwshubSentinelDetail, { run_id: BUG_RUN });
    expect(out.maxFreeText).toBe(4000);
    expect(out.data.has_patch).toBe(true);
    expect(JSON.stringify(out.data)).not.toContain('+++ b/src/checkout.js');
    const env = (await import('../src/mcp/envelope.js')).wrap({ tool: 't', units: null, rowCount: 1, truncated: false, asOf: new Date(), system: 'dwshub', maxFreeText: out.maxFreeText }, out.data);
    const rootCause = ((env.data as { result: { root_cause: string } }).result.root_cause);
    expect(rootCause.length).toBeGreaterThan(1000);
    expect(env._integrity).toMatch(/^Data from the DWS Hub/);
    expect(env.source).toBe('DWS Hub production via a read-only service key');
    expect(env.environment).toBe('production');
  });

  it('dwshub_bug_reports passes the planted instruction through as data, counted as unanalysed', async () => {
    const out = await call(m.tools.dwshubBugReports, { status: 'open' });
    expect(out.data.unanalysed).toBe(1);
  });

  it('a rejected service key is an UPSTREAM_AUTH error that says what to check', async () => {
    state.rejectKey = true;
    await expect(call(m.tools.dwshubAppHealth, {})).rejects.toMatchObject({ code: 'UPSTREAM_AUTH' });
  });

  it('rejects a malformed run id before calling the Hub', async () => {
    await expect(call(m.tools.dwshubSentinelDetail, { run_id: '../admin' })).rejects.toThrow();
    expect(state.requests).toHaveLength(0);
  });
});

describe('admin only', () => {
  async function listTools(identity: { userId: string; isAdmin?: boolean }): Promise<string[]> {
    const server = m.mcp.createServer(identity);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a as never), client.connect(b as never)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  }

  it('advertises dwshub_* to admins only', async () => {
    expect((await listTools({ userId: 'admin@example.com', isAdmin: true })).filter((n) => n.startsWith('dwshub_'))).toHaveLength(5);
    expect((await listTools({ userId: 'pilot@example.com', isAdmin: false })).filter((n) => n.startsWith('dwshub_'))).toHaveLength(0);
    expect((await listTools({ userId: 'pilot@example.com' })).some((n) => n.startsWith('klip_'))).toBe(true);
  });

  it('reads the admin flag from the database, and a disabled admin is not one', async () => {
    expect(await m.mcp.lookupAdmin('admin@example.com')).toBe(true);
    expect(await m.mcp.lookupAdmin('pilot@example.com')).toBe(false);
    expect(await m.mcp.lookupAdmin('gone@example.com')).toBe(false);
    expect(await m.mcp.lookupAdmin('nobody@example.com')).toBe(false);
  });

  it('the runner refuses an admin-only tool for a non-admin, before the Hub is called', async () => {
    const def = m.index.allDwsHubTools[0]!;
    const r = await m.runner.runTool(def, {}, { requestId: 'r', userId: 'pilot@example.com', isAdmin: false });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('administrators only');
    expect(state.requests).toHaveLength(0);
  });

  it('the runner carries the system through, so the live envelope says DWS Hub', async () => {
    const def = m.index.allDwsHubTools[0]!;
    const r = await m.runner.runTool(def, {}, admin);
    expect(r.isError).toBeUndefined();
    expect((r.structuredContent as { _integrity: string; source: string })._integrity).toMatch(/^Data from the DWS Hub/);
  });
});

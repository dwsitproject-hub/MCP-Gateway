/**
 * dwshub_set_sentinel_model - the gateway's one write to the DWS Hub.
 *
 * What these pin:
 *   - it is a separate tool family: the read-only dwshub_* family and its guarantees are
 *     unchanged, and the control tool only exists when DWSHUB_CONTROL_KEY is set;
 *   - it sends exactly one PUT, to the one control route, with the CONTROL key (never the
 *     read key), naming the person behind the call;
 *   - the Hub's answer decides: an unknown model is the Hub's 400 with its list, a rejected
 *     key is UPSTREAM_AUTH;
 *   - admins only: hidden from and refused for everyone else;
 *   - it advertises itself as a write (readOnlyHint false).
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MOCK_DWSHUB_CONTROL_KEY, MOCK_DWSHUB_KEY, createMockDwsHub, freshDwsHubState, type MockDwsHubState } from './fixtures/mockDwsHub.js';
import { PORTS } from './fixtures/ports.js';

vi.mock('../src/core/audit.js', () => ({
  write: vi.fn().mockResolvedValue(undefined),
  newRequestId: () => 'test-request',
}));
vi.mock('../src/auth/users.js', () => ({
  findByEmail: vi.fn(async (email: string) => (email === 'admin@example.com' ? { is_admin: true, disabled_at: null } : { is_admin: false, disabled_at: null })),
}));

const PORT = PORTS.dwshubControl;
let server: Server;
let state: MockDwsHubState;

type Mods = {
  control: typeof import('../src/adapters/dwshub/control.js');
  tool: typeof import('../src/tools/dwshub/control.js');
  index: typeof import('../src/tools/dwshub/index.js');
  mcp: typeof import('../src/mcp/server.js');
  runner: typeof import('../src/mcp/runner.js');
};
let m: Mods;

const admin = { requestId: 'r', userId: 'admin@example.com', isAdmin: true };

async function setModel(model: string) {
  const parsed = z.strictObject(m.tool.dwshubSetSentinelModel.inputShape).parse({ model });
  return m.tool.dwshubSetSentinelModel.handler(parsed, admin);
}

beforeAll(async () => {
  process.env.DWSHUB_BASE_URL = `http://127.0.0.1:${PORT}/api/service/v1`;
  process.env.DWSHUB_SERVICE_KEY = MOCK_DWSHUB_KEY;
  process.env.DWSHUB_CONTROL_KEY = MOCK_DWSHUB_CONTROL_KEY;
  process.env.DWSHUB_ENV = 'production';
  state = freshDwsHubState();
  await new Promise<void>((resolve) => { server = createMockDwsHub(state).listen(PORT, '127.0.0.1', () => resolve()); });
  m = {
    control: await import('../src/adapters/dwshub/control.js'),
    tool: await import('../src/tools/dwshub/control.js'),
    index: await import('../src/tools/dwshub/index.js'),
    mcp: await import('../src/mcp/server.js'),
    runner: await import('../src/mcp/runner.js'),
  };
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { state.requests.length = 0; state.rejectKey = false; state.model = 'claude-opus-5-5'; });

describe('configuration', () => {
  it('derives the control root from DWSHUB_BASE_URL and keeps the tool out of the read-only family', () => {
    expect(m.control.controlRoot()).toBe(`http://127.0.0.1:${PORT}/api/service/control/v1`);
    expect(m.control.dwshubControlConfigured()).toBe(true);
    expect(m.index.dwshubControlTools.map((t) => t.name)).toEqual(['dwshub_set_sentinel_model']);
    expect(m.index.dwshubToolNames).not.toContain('dwshub_set_sentinel_model');
    for (const t of m.index.allDwsHubTools) expect(t.readOnly).not.toBe(false);
  });

  it('declares itself as a write, admin-only', () => {
    const t = m.tool.dwshubSetSentinelModel;
    expect(t.readOnly).toBe(false);
    expect(t.adminOnly).toBe(true);
    expect(t.description).toContain('WRITES ONE SETTING');
  });
});

describe('dwshub_set_sentinel_model', () => {
  it('sends one PUT to the control route with the control key and the caller', async () => {
    const out = await setModel('claude-sonnet-5-5');
    expect(out.data).toMatchObject({ model: 'claude-sonnet-5-5', previous: 'claude-opus-5-5', changed: true, set_by: 'mcp-gateway (admin@example.com)' });
    expect(out.system).toBe('dwshub');
    expect(state.requests).toHaveLength(1);
    const [r] = state.requests;
    expect(r).toMatchObject({ method: 'PUT', path: '/api/service/control/v1/sentinel/model', auth: `Bearer ${MOCK_DWSHUB_CONTROL_KEY}` });
    expect(r?.body).toEqual({ model: 'claude-sonnet-5-5', requested_by: 'admin@example.com' });
    expect(state.model).toBe('claude-sonnet-5-5');
  });

  it('setting the current model is a no-op, and says so', async () => {
    const out = await setModel('claude-opus-5-5');
    expect((out.data as { changed: boolean; note: string }).changed).toBe(false);
    expect((out.data as { note: string }).note).toContain('nothing changed');
  });

  it('an unknown model is the Hub\'s 400, listing the Hub\'s models', async () => {
    await expect(setModel('claude-imaginary-9')).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('claude-opus-5-5') });
    expect(state.model).toBe('claude-opus-5-5');
  });

  it('refuses something that is not a Claude model id before calling the Hub', () => {
    expect(() => z.strictObject(m.tool.dwshubSetSentinelModel.inputShape).parse({ model: 'gpt-5; DROP' })).toThrow();
    expect(() => z.strictObject(m.tool.dwshubSetSentinelModel.inputShape).parse({ model: 'claude-opus-5-5', extra: 1 })).toThrow();
  });

  it('a rejected control key is UPSTREAM_AUTH', async () => {
    state.rejectKey = true;
    await expect(setModel('claude-opus-5-5')).rejects.toMatchObject({ code: 'UPSTREAM_AUTH' });
  });
});

describe('provenance on the live path', () => {
  it('does not call a write "read-only" when it reaches a user through the runner', async () => {
    // The dwshub envelope says "read-only gateway path" and "read-only service key". On a
    // write that is false, and it reads as a claim that nothing changed. Driven through
    // runTool, because the JPS label bug hid for five weeks behind tests that called wrap().
    const def = m.index.dwshubControlTools[0]!;
    const r = await m.runner.runTool(def, { model: 'claude-sonnet-5-5' }, admin);
    expect(r.isError).toBeUndefined();
    const env = r.structuredContent as { _integrity: string; source: string };
    expect(env._integrity).toMatch(/CHANGE made in the DWS Hub/);
    expect(env._integrity).not.toMatch(/read-only/);
    expect(env.source).toMatch(/control key/);
    expect(env.source).not.toMatch(/read-only/);
  });

  it('tells admins about the one write, in the instructions they start from', () => {
    expect(m.mcp.DWSHUB_CONTROL_INSTRUCTIONS).toMatch(/dwshub_set_sentinel_model, which WRITES/);
  });
});

describe('admin only', () => {
  async function listTools(identity: { userId: string; isAdmin?: boolean }) {
    const srv = m.mcp.createServer(identity);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([srv.connect(a as never), client.connect(b as never)]);
    const tools = (await client.listTools()).tools;
    await client.close();
    return tools;
  }

  it('is advertised to admins only, as a non-read-only tool', async () => {
    const adminTool = (await listTools(admin)).find((t) => t.name === 'dwshub_set_sentinel_model');
    expect(adminTool?.annotations?.readOnlyHint).toBe(false);
    expect((await listTools({ userId: 'pilot@example.com', isAdmin: false })).some((t) => t.name === 'dwshub_set_sentinel_model')).toBe(false);
  });

  it('the runner refuses it for a non-admin, before the Hub is called', async () => {
    const def = m.index.dwshubControlTools[0]!;
    const r = await m.runner.runTool(def, { model: 'claude-haiku-4-5' }, { requestId: 'r', userId: 'pilot@example.com', isAdmin: false });
    expect(r.isError).toBe(true);
    expect(state.requests).toHaveLength(0);
    expect(state.model).toBe('claude-opus-5-5');
  });
});

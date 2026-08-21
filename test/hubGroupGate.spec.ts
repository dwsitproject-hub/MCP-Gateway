/**
 * The optional Hub group gate.
 *
 * HUB_REQUIRED_GROUP is a second authorization control in front of the pilot
 * allowlist: useful when the Hub already models a "klip-connector-pilot" group, so
 * membership can be managed centrally rather than only in this gateway's table.
 *
 * Its own spec file because the value is read at config load, and ESM hoists imports.
 */
import { startMockHub, type MockHub } from './fixtures/mockHub.js';

const PORT = 5191;
process.env.HUB_ISSUER = `http://127.0.0.1:${PORT}`;
process.env.HUB_CLIENT_ID = 'mcp-gateway-test-client';
process.env.HUB_CLIENT_SECRET = 'mcp-gateway-test-secret';
process.env.HUB_REQUIRED_GROUP = 'klip-connector-pilot';

const { afterAll, beforeAll, beforeEach, describe, expect, it } = await import('vitest');
const hubRp = await import('../src/auth/hub.js');

let hub: MockHub;
const NONCE = 'gate-nonce';
const VERIFIER = 'gate-verifier';

beforeAll(async () => {
  hub = await startMockHub(PORT);
});
afterAll(async () => {
  await new Promise<void>((resolve) => hub.server.close(() => resolve()));
});
beforeEach(() => {
  hub.reset();
  hubRp.resetCache();
  hub.options.nonce = NONCE;
});

describe('HUB_REQUIRED_GROUP', () => {
  it('admits a user who is in the required group', async () => {
    hub.options.claims = { groups: ['it-department', 'klip-connector-pilot'] };
    const identity = await hubRp.exchangeCode('c', VERIFIER, NONCE);
    expect(identity.email).toBe('someone@example.com');
  });

  it('matches the group case-insensitively', async () => {
    hub.options.claims = { groups: ['KLIP-Connector-Pilot'] };
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).resolves.toMatchObject({
      subject: 'hub-subject-0001',
    });
  });

  it('REFUSES a user who is not in the required group', async () => {
    hub.options.claims = { groups: ['it-department'] };
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'not_permitted' });
  });

  it('REFUSES a user whose token carries no groups claim at all', async () => {
    hub.options.claims = { groups: [] };
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'not_permitted' });
  });

  it('does not let a near-miss group name through', async () => {
    hub.options.claims = { groups: ['klip-connector-pilot-readonly', 'klip-connector'] };
    await expect(hubRp.exchangeCode('c', VERIFIER, NONCE)).rejects.toMatchObject({ reason: 'not_permitted' });
  });
});

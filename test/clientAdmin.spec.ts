/**
 * client:list / client:disable / client:enable - managing OAuth clients from the CLI.
 *
 * What these pin:
 *   - disabling a client stamps disabled_at and revokes that client's refresh tokens only;
 *   - an unknown or already-disabled client is reported, and no tokens are touched;
 *   - enable clears disabled_at only for a client that is disabled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));
vi.mock('../src/core/db.js', () => db);

const { disableClient, enableClient, listClients } = await import('../src/auth/clients.js');

beforeEach(() => { db.query.mockReset(); db.queryOne.mockReset(); });

describe('disableClient', () => {
  it('disables the client and revokes only its own refresh tokens', async () => {
    db.queryOne.mockResolvedValueOnce({ client_name: 'Milo - CEO' });
    db.query.mockResolvedValueOnce([{ n: 3 }]);
    await expect(disableClient('abc')).resolves.toEqual({ name: 'Milo - CEO', revoked: 3 });
    const [update, params] = db.queryOne.mock.calls[0]!;
    expect(update).toMatch(/SET disabled_at = now\(\) WHERE client_id = \$1 AND disabled_at IS NULL/);
    expect(params).toEqual(['abc']);
    const [revoke, rparams] = db.query.mock.calls[0]!;
    expect(revoke).toMatch(/UPDATE oauth_tokens SET revoked_at = now\(\) WHERE client_id = \$1 AND revoked_at IS NULL/);
    expect(rparams).toEqual(['abc']);
  });

  it('touches no tokens when the client is unknown or already disabled', async () => {
    db.queryOne.mockResolvedValueOnce(undefined);
    await expect(disableClient('nope')).resolves.toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('enableClient', () => {
  it('re-enables a disabled client only', async () => {
    db.queryOne.mockResolvedValueOnce({ client_name: 'Milo - CEO' });
    await expect(enableClient('abc')).resolves.toEqual({ name: 'Milo - CEO' });
    expect(db.queryOne.mock.calls[0]![0]).toMatch(/SET disabled_at = NULL WHERE client_id = \$1 AND disabled_at IS NOT NULL/);
    db.queryOne.mockResolvedValueOnce(undefined);
    await expect(enableClient('abc')).resolves.toBeUndefined();
  });
});

describe('listClients', () => {
  it('is a single read that never returns the secret hash', async () => {
    db.query.mockResolvedValueOnce([]);
    await listClients();
    const [sql] = db.query.mock.calls[0]!;
    expect(sql).toMatch(/^\s*SELECT/);
    expect(sql).toMatch(/client_secret_hash IS NOT NULL\) AS has_secret/);
    expect(sql).not.toMatch(/c\.client_secret_hash,/);
  });
});

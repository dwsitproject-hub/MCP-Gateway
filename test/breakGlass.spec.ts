/**
 * The "exactly one break-glass account" invariant.
 *
 * Break-glass is the single local password that bypasses Downstream Hub, so it is the
 * one credential that can reach production KLIP without the identity provider. Two of
 * them is not a tidiness problem - it is a second, unwatched way in.
 *
 * The guard shipped with a hole and a misleading remedy: it matched on is_break_glass
 * alone, ignoring disabled_at, while its error read "disable it first". Running
 * user:disable therefore changed nothing and the operator was told to do the one thing
 * that could not work. Found on 14 Sep 2026 while splitting a person's pilot account
 * from the emergency one on production.
 *
 * These tests pin both directions of the invariant, because closing only the
 * provisioning side leaves re-enable as a silent way back to two.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeCall {
  sql: string;
  params: readonly unknown[];
}

const calls: FakeCall[] = [];
let responder: (sql: string, params: readonly unknown[]) => unknown[] = () => [];

vi.mock('../src/core/db.js', () => ({
  query: async (sql: string, params: readonly unknown[] = []): Promise<unknown[]> => {
    calls.push({ sql, params });
    return responder(sql, params);
  },
  queryOne: async (sql: string, params: readonly unknown[] = []): Promise<unknown> => {
    calls.push({ sql, params });
    return responder(sql, params)[0];
  },
}));

// argon2id is deliberately expensive; the hash itself is not what these tests check.
vi.mock('@node-rs/argon2', () => ({
  hash: async (): Promise<string> => '$argon2id$fake',
  verify: async (): Promise<boolean> => true,
}));

const users = await import('../src/auth/users.js');

/** A row shaped like the users table, with only the columns these tests read. */
function row(email: string, opts: { breakGlass?: boolean; disabled?: boolean } = {}): Record<string, unknown> {
  return {
    id: `id-${email}`,
    email,
    is_break_glass: opts.breakGlass ?? false,
    disabled_at: opts.disabled === true ? new Date() : null,
  };
}

/** Answer the guard query the way Postgres would, honouring its WHERE clause. */
function tableOf(rows: Array<Record<string, unknown>>) {
  return (sql: string, params: readonly unknown[]): unknown[] => {
    if (sql.includes('SELECT * FROM users WHERE lower(email)')) {
      const wanted = String(params[0]).toLowerCase();
      return rows.filter((r) => String(r.email).toLowerCase() === wanted);
    }
    if (sql.includes('is_break_glass = TRUE')) {
      const excluded = String(params[0]).toLowerCase();
      return rows.filter(
        (r) =>
          r.is_break_glass === true &&
          // The clause under test. A guard that omits this reads a disabled account as
          // still occupying the slot.
          (sql.includes('disabled_at IS NULL') ? r.disabled_at === null : true) &&
          String(r.email).toLowerCase() !== excluded,
      );
    }
    return [];
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe('provisioning the break-glass account', () => {
  it('refuses while another ACTIVE break-glass account exists', async () => {
    responder = tableOf([row('old@example.com', { breakGlass: true })]);
    await expect(users.addBreakGlassUser('new@example.com', 'a-long-enough-password')).rejects.toThrow(
      /ACTIVE break-glass account already exists \(old@example\.com\)/,
    );
  });

  it('names the exact command that clears the way', async () => {
    // The original error said "disable it first" and disabling did not help. If the
    // message names a remedy, the remedy has to work.
    responder = tableOf([row('old@example.com', { breakGlass: true })]);
    await expect(users.addBreakGlassUser('new@example.com', 'a-long-enough-password')).rejects.toThrow(
      /user:disable old@example\.com/,
    );
  });

  it('allows provisioning once the previous one is DISABLED', async () => {
    // The regression. Before the fix this threw, leaving the operator with an
    // instruction that could not be carried out.
    responder = tableOf([row('old@example.com', { breakGlass: true, disabled: true })]);
    const user = await users.addBreakGlassUser('new@example.com', 'a-long-enough-password', 'Break glass');
    expect(user.email).toBe('new@example.com');
    expect(user.authSource).toBe('local');
    expect(user.mustChangePassword).toBe(true);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO users'));
    expect(insert?.sql).toContain("'local'");
  });

  it('re-provisioning the SAME address replaces it rather than colliding', async () => {
    responder = tableOf([row('same@example.com', { breakGlass: true })]);
    await expect(users.addBreakGlassUser('same@example.com', 'a-long-enough-password')).resolves.toBeDefined();
  });
});

describe('re-enabling', () => {
  it('refuses to bring back a break-glass account while another is active', async () => {
    // The other half of the invariant: disable the old one, provision a new one, then
    // re-enable the old for an unrelated reason and there are quietly two passwords
    // that bypass the Hub.
    responder = tableOf([
      row('old@example.com', { breakGlass: true, disabled: true }),
      row('new@example.com', { breakGlass: true }),
    ]);
    await expect(users.enable('old@example.com')).rejects.toThrow(/new@example\.com is already the active one/);
  });

  it('allows re-enabling when no other break-glass account is active', async () => {
    responder = tableOf([row('old@example.com', { breakGlass: true, disabled: true })]);
    await expect(users.enable('old@example.com')).resolves.toBeUndefined();
  });

  it('never blocks an ordinary pilot user', async () => {
    responder = tableOf([
      row('someone@example.com', { disabled: true }),
      row('breakglass@example.com', { breakGlass: true }),
    ]);
    await expect(users.enable('someone@example.com')).resolves.toBeUndefined();
  });
});

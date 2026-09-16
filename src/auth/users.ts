/**
 * User store (TSD Section 8.3, reworked per review H2).
 *
 * Downstream Hub OIDC authenticates the human. This table is the pilot
 * ALLOWLIST — the authorization decision — and the two are deliberately separate.
 *
 * Why not just admit anyone the Hub authenticates? Phase 1 uses one shared KLIP
 * service account, so every admitted user can read everything MCP_READONLY can
 * read (review H8). Pilot membership therefore IS the data-access control, and
 * JIT-provisioning the whole organisation would widen access silently and break
 * the "<= 15 pilot users" cap in PRD Section 16. Q4's vetting is what this table
 * records.
 *
 * Two account kinds:
 *   auth_source = 'hub'   - normal pilot user, no password, matched on the Hub's
 *                           `sub` (pinned at first login) or email
 *   auth_source = 'local' - the single break-glass account, argon2id password,
 *                           used only when the Hub is down or misconfigured
 */
import { randomUUID } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { query, queryOne } from './../core/db.js';
import { logger } from './../core/logger.js';
import { cfg } from './../core/config.js';

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

const ARGON_OPTS = {
  // argon2id tuned for an interactive login on a 2 vCPU host.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export type AuthSource = 'hub' | 'local';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  must_change_pw: boolean;
  disabled_at: Date | null;
  failed_logins: number;
  locked_until: Date | null;
  auth_source: AuthSource;
  hub_subject: string | null;
  is_break_glass: boolean;
  is_admin: boolean;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  mustChangePassword: boolean;
  authSource: AuthSource;
}

/** One row of the pilot list as the admin UI shows it. */
export interface PilotRow {
  email: string;
  displayName: string | null;
  authSource: AuthSource;
  isBreakGlass: boolean;
  isAdmin: boolean;
  disabled: boolean;
  hubLinked: boolean;
  lastLoginAt: Date | null;
}

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'bad_credentials' | 'disabled' | 'locked' | 'not_local'; retryAfterMinutes?: number };

export type HubAdmission =
  | { ok: true; user: User }
  | { ok: false; reason: 'not_on_pilot_list' | 'disabled' | 'subject_mismatch' };

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export async function findByEmail(email: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
}

export async function findByHubSubject(subject: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE hub_subject = $1', [subject]);
}

export async function isActive(userId: string): Promise<boolean> {
  const row = await queryOne<{ disabled_at: Date | null }>('SELECT disabled_at FROM users WHERE id = $1', [userId]);
  return row !== undefined && row.disabled_at === null;
}

export async function list(): Promise<
  Array<
    Pick<
      UserRow,
      | 'email'
      | 'display_name'
      | 'auth_source'
      | 'is_break_glass'
      | 'is_admin'
      | 'disabled_at'
      | 'locked_until'
      | 'hub_subject'
    >
  >
> {
  return query(
    `SELECT email, display_name, auth_source, is_break_glass, is_admin, disabled_at, locked_until, hub_subject
       FROM users ORDER BY is_break_glass DESC, email`,
  );
}

export async function countActivePilots(): Promise<number> {
  const row = await queryOne<{ n: string }>(
    "SELECT count(*)::text AS n FROM users WHERE disabled_at IS NULL AND auth_source = 'hub'",
  );
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** Add a pilot user who will authenticate through Downstream Hub. No password. */
export async function addHubUser(email: string, displayName?: string): Promise<User> {
  const id = randomUUID();
  const normalised = email.trim().toLowerCase();
  await query(
    `INSERT INTO users (id, email, password_hash, display_name, must_change_pw, auth_source)
     VALUES ($1, $2, NULL, $3, FALSE, 'hub')`,
    [id, normalised, displayName ?? null],
  );
  logger.info({ email: normalised }, 'pilot user added (Downstream Hub authentication)');
  return { id, email: normalised, displayName: displayName ?? null, mustChangePassword: false, authSource: 'hub' };
}

/** Create or replace the single break-glass local account. */
export async function addBreakGlassUser(email: string, password: string, displayName?: string): Promise<User> {
  // ACTIVE is the invariant, not merely present. The first version of this check
  // omitted `disabled_at IS NULL` while its error said "disable it first", so the one
  // remedy it named did nothing and the operator was stuck with no way forward.
  const existing = await query<{ email: string }>(
    "SELECT email FROM users WHERE is_break_glass = TRUE AND disabled_at IS NULL AND lower(email) <> lower($1)",
    [email.trim()],
  );
  if (existing.length > 0) {
    throw new Error(
      `an ACTIVE break-glass account already exists (${existing[0]?.email}). Exactly one is expected. ` +
        `Run: user:disable ${existing[0]?.email}`,
    );
  }

  const id = randomUUID();
  const normalised = email.trim().toLowerCase();
  const passwordHash = await argonHash(password, ARGON_OPTS);
  await query(
    `INSERT INTO users (id, email, password_hash, display_name, must_change_pw, auth_source, is_break_glass)
     VALUES ($1, $2, $3, $4, TRUE, 'local', TRUE)
     ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            auth_source = 'local',
            is_break_glass = TRUE,
            must_change_pw = TRUE,
            disabled_at = NULL,
            failed_logins = 0,
            locked_until = NULL`,
    [id, normalised, passwordHash, displayName ?? null],
  );
  logger.warn({ email: normalised }, 'break-glass local account provisioned');
  return { id, email: normalised, displayName: displayName ?? null, mustChangePassword: true, authSource: 'local' };
}

/**
 * Demote a break-glass account to an ordinary Downstream Hub pilot user.
 *
 * Needed because the flag was previously a one-way door. Provisioning break-glass
 * against a person's own address - easy to do, since it is the address to hand -
 * permanently marked that account local, and the "exactly one active" rule then
 * refused to re-enable it once a proper emergency account existed. Two correct guards
 * met and left the operator with no move except editing the users table by hand.
 *
 * The password hash is CLEARED, not kept. A demoted account that still holds a working
 * local password is exactly the unwatched second way in that the one-account rule
 * exists to prevent - the flag would say Hub-only while the password path stayed open.
 */
/** The pilot list, shaped for display. Break-glass first, then alphabetical. */
export async function listPilots(): Promise<PilotRow[]> {
  const rows = await query<UserRow & { last_login_at: Date | null }>(
    `SELECT email, display_name, auth_source, is_break_glass, is_admin, disabled_at, hub_subject, last_login_at
       FROM users ORDER BY is_break_glass DESC, email`,
  );
  return rows.map((r) => ({
    email: r.email,
    displayName: r.display_name,
    authSource: r.auth_source,
    isBreakGlass: r.is_break_glass,
    isAdmin: r.is_admin,
    disabled: r.disabled_at !== null,
    hubLinked: r.hub_subject !== null,
    lastLoginAt: r.last_login_at,
  }));
}

/**
 * Grant or revoke administrator rights over the pilot list.
 *
 * Revoking the LAST admin is refused. Not tidiness: the only way back would be shell
 * access to the host, and an admin UI whose own controls can lock every administrator
 * out of it is a trap that looks like a working feature right up until it is used.
 */
export async function setAdmin(email: string, isAdmin: boolean): Promise<void> {
  const target = await findByEmail(email);
  if (target === undefined) throw new Error(`no such user: ${email.trim()}`);

  if (!isAdmin && target.is_admin) {
    const others = await query<{ email: string }>(
      'SELECT email FROM users WHERE is_admin = TRUE AND disabled_at IS NULL AND lower(email) <> lower($1)',
      [email.trim()],
    );
    if (others.length === 0) {
      throw new Error(
        `${target.email} is the only administrator. Grant another one first (user:grant-admin <email>), ` +
          'or the pilot list becomes editable only from a shell on the host.',
      );
    }
  }

  await query('UPDATE users SET is_admin = $2 WHERE lower(email) = lower($1)', [email.trim(), isAdmin]);
  logger.warn({ email: target.email, isAdmin }, 'administrator rights changed');
}

export async function clearBreakGlass(email: string): Promise<void> {
  const target = await findByEmail(email);
  if (target === undefined) throw new Error(`no such user: ${email.trim()}`);
  if (!target.is_break_glass) throw new Error(`${target.email} is not a break-glass account; nothing to clear`);

  // Demoting the last ACTIVE one would leave no way in at all if the Hub goes down,
  // which is the situation break-glass exists for. Named remedies, both of which work.
  if (target.disabled_at === null && cfg.BREAK_GLASS_ENABLED) {
    const other = await query<{ email: string }>(
      "SELECT email FROM users WHERE is_break_glass = TRUE AND disabled_at IS NULL AND lower(email) <> lower($1)",
      [email.trim()],
    );
    if (other.length === 0) {
      throw new Error(
        `${target.email} is the only ACTIVE break-glass account and BREAK_GLASS_ENABLED is true. ` +
          'Provision a replacement first (user:add-break-glass <other-email>), or set ' +
          'BREAK_GLASS_ENABLED=false to drop the password path deliberately.',
      );
    }
  }

  await query(
    `UPDATE users
        SET is_break_glass = FALSE, auth_source = 'hub', password_hash = NULL, must_change_pw = FALSE
      WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  logger.warn({ email: target.email }, 'break-glass cleared; account is now Downstream Hub only');
}

export async function setPassword(email: string, password: string): Promise<void> {
  const row = await findByEmail(email);
  if (row === undefined) throw new Error(`no such user: ${email}`);
  if (row.auth_source !== 'local') {
    throw new Error(`${row.email} authenticates through Downstream Hub and has no password to set`);
  }
  const passwordHash = await argonHash(password, ARGON_OPTS);
  await query(
    `UPDATE users SET password_hash = $2, must_change_pw = FALSE, failed_logins = 0, locked_until = NULL
      WHERE id = $1`,
    [row.id, passwordHash],
  );
}

export async function disable(email: string): Promise<void> {
  await query('UPDATE users SET disabled_at = now() WHERE lower(email) = lower($1)', [email.trim()]);
}

export async function enable(email: string): Promise<void> {
  /**
   * Re-enabling is where the "exactly one break-glass" invariant is easiest to break:
   * disable the old emergency account, provision a new one, then re-enable the old for
   * an unrelated reason and there are silently two passwords that bypass Downstream Hub.
   * Refused here rather than discovered in an audit.
   */
  const target = await findByEmail(email);
  if (target?.is_break_glass === true) {
    const other = await query<{ email: string }>(
      "SELECT email FROM users WHERE is_break_glass = TRUE AND disabled_at IS NULL AND lower(email) <> lower($1)",
      [email.trim()],
    );
    if (other.length > 0) {
      throw new Error(
        `cannot re-enable ${email.trim()}: it is a break-glass account and ${other[0]?.email} is already the ` +
          'active one. Exactly one may bypass Downstream Hub at a time.',
      );
    }
  }
  await query(
    'UPDATE users SET disabled_at = NULL, failed_logins = 0, locked_until = NULL WHERE lower(email) = lower($1)',
    [email.trim()],
  );
}

// ---------------------------------------------------------------------------
// Hub admission
// ---------------------------------------------------------------------------

/**
 * Decide whether a Hub-authenticated identity may use the connector.
 *
 * Matching is by `sub` first, falling back to email for a first-ever login. The
 * `sub` is then PINNED, so a later change of email address at the Hub cannot
 * silently attach one person's access to another person's pilot entry.
 */
export async function admitHubIdentity(identity: {
  subject: string;
  email: string;
  displayName: string | null;
}): Promise<HubAdmission> {
  const bySubject = await findByHubSubject(identity.subject);
  const row = bySubject ?? (await findByEmail(identity.email));

  if (row === undefined) {
    logger.warn({ email: identity.email }, 'Hub sign-in refused: not on the pilot list');
    return { ok: false, reason: 'not_on_pilot_list' };
  }
  if (row.disabled_at !== null) return { ok: false, reason: 'disabled' };

  // Someone else already claimed this pilot entry with a different Hub subject.
  if (row.hub_subject !== null && row.hub_subject !== identity.subject) {
    logger.error(
      { email: row.email },
      'Hub sign-in refused: the pilot entry is bound to a different Hub subject',
    );
    return { ok: false, reason: 'subject_mismatch' };
  }

  if (row.hub_subject === null) {
    await query('UPDATE users SET hub_subject = $2, auth_source = $3 WHERE id = $1', [
      row.id,
      identity.subject,
      row.is_break_glass ? row.auth_source : 'hub',
    ]);
    logger.info({ email: row.email }, 'pinned Hub subject to pilot entry on first sign-in');
  }

  await query(
    'UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL, display_name = COALESCE($2, display_name) WHERE id = $1',
    [row.id, identity.displayName],
  );

  return {
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      displayName: identity.displayName ?? row.display_name,
      mustChangePassword: false,
      authSource: 'hub',
    },
  };
}

// ---------------------------------------------------------------------------
// Break-glass password authentication
// ---------------------------------------------------------------------------

/**
 * Verify a local break-glass password. Refuses outright when the break-glass path
 * is disabled, and refuses for any account that is Hub-authenticated - so turning
 * the Hub off is not a way to fall back to a password nobody set.
 */
export async function authenticate(email: string, password: string): Promise<AuthResult> {
  if (!cfg.BREAK_GLASS_ENABLED) {
    logger.warn({ email }, 'password sign-in attempted while the break-glass path is disabled');
    return { ok: false, reason: 'not_local' };
  }

  const row = await findByEmail(email);

  if (row === undefined || row.password_hash === null) {
    // Constant-ish work even for an unknown address, to avoid a timing oracle.
    await argonVerify(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzYWx0$0000000000000000000000000000000000000000000',
      password,
    ).catch(() => false);
    return { ok: false, reason: row === undefined ? 'bad_credentials' : 'not_local' };
  }

  if (row.auth_source !== 'local') return { ok: false, reason: 'not_local' };
  if (row.disabled_at !== null) return { ok: false, reason: 'disabled' };

  if (row.locked_until !== null && row.locked_until.getTime() > Date.now()) {
    const minutes = Math.ceil((row.locked_until.getTime() - Date.now()) / 60_000);
    return { ok: false, reason: 'locked', retryAfterMinutes: minutes };
  }

  let valid = false;
  try {
    valid = await argonVerify(row.password_hash, password);
  } catch {
    valid = false;
  }

  if (!valid) {
    const failures = row.failed_logins + 1;
    if (failures >= MAX_FAILURES) {
      await query(
        `UPDATE users SET failed_logins = 0, locked_until = now() + ($2 || ' minutes')::INTERVAL WHERE id = $1`,
        [row.id, String(LOCKOUT_MINUTES)],
      );
      logger.warn({ email: row.email }, 'break-glass account locked after repeated failures');
      return { ok: false, reason: 'locked', retryAfterMinutes: LOCKOUT_MINUTES };
    }
    await query('UPDATE users SET failed_logins = $2 WHERE id = $1', [row.id, failures]);
    return { ok: false, reason: 'bad_credentials' };
  }

  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [row.id]);

  return {
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      mustChangePassword: row.must_change_pw,
      authSource: 'local',
    },
  };
}

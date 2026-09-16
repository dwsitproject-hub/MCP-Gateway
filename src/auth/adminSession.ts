/**
 * The admin UI's browser session.
 *
 * Deliberately NOT a new login path. The only way to obtain one of these is to
 * complete the existing Downstream Hub round trip and come back as a user who is on
 * the pilot list AND carries is_admin - so the admin UI adds a third check on top of
 * the two that already exist, and no fourth way in.
 *
 * Signed with the gateway's own OAuth key rather than stored in a table, for the same
 * reason the pending-authorization token is: it is tamper-proof, it expires by itself,
 * and there is no session row to leak, forget to delete, or grow without bound.
 *
 * SHORT LIFE ON PURPOSE. Thirty minutes, because this session can hand production
 * commercial data to anyone the holder chooses to add. An admin who leaves a tab open
 * is the likeliest way it gets misused, and a page that quietly stops working after
 * half an hour is a much smaller problem than one that never does.
 */
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { loadKeys } from './keys.js';
import { cfg } from './../core/config.js';

const AUDIENCE = 'mcp-gateway-admin-session';
export const ADMIN_SESSION_COOKIE = 'mcp_admin';
export const ADMIN_SESSION_TTL_SECONDS = 30 * 60;

export interface AdminSession {
  userId: string;
  email: string;
  /**
   * Bound to THIS session and echoed in every form. Not a double-submit cookie: the
   * value never travels in a cookie of its own, so it cannot be set by a subdomain or
   * read back by anything that manages to plant one.
   */
  csrf: string;
}

export async function issueAdminSession(userId: string, email: string): Promise<string> {
  const { privateKey, kid } = await loadKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, csrf: randomBytes(24).toString('base64url') })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(userId)
    .setIssuer(cfg.issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ADMIN_SESSION_TTL_SECONDS)
    .sign(privateKey);
}

/** Undefined for anything that is not a live, well-formed session of ours. */
export async function readAdminSession(token: string | undefined): Promise<AdminSession | undefined> {
  if (token === undefined || token === '') return undefined;
  try {
    const { publicKey } = await loadKeys();
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: cfg.issuer,
      audience: AUDIENCE,
      algorithms: ['RS256'],
    });
    const userId = payload.sub;
    const email = payload.email;
    const csrf = payload.csrf;
    if (typeof userId !== 'string' || typeof email !== 'string' || typeof csrf !== 'string') return undefined;
    return { userId, email, csrf };
  } catch {
    // Expired, tampered with, or signed by a key we have rotated away from. All three
    // mean "sign in again", and saying which would be a free hint to anyone probing.
    return undefined;
  }
}

/** Cookie attributes, kept in one place so the clear matches the set exactly. */
export function adminCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge?: number;
} {
  return {
    httpOnly: true,
    secure: cfg.isProduction,
    // Lax, not Strict: the session is established by a redirect BACK from Downstream
    // Hub, and Strict would withhold the cookie on that first cross-site navigation -
    // so the admin would land on /admin already signed in and be told they are not.
    sameSite: 'lax',
    path: '/admin',
  };
}

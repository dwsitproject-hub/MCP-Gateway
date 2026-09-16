/**
 * The pilot-list admin UI, at /admin on the public host.
 *
 * THREE separate checks stand between the internet and this page, and they answer
 * three different questions:
 *
 *   Downstream Hub   who are you
 *   pilot list       may you use the connector
 *   is_admin         may you change who else can
 *
 * The third is granted only from a shell on the host (`user:grant-admin`). A web UI
 * that can mint its own first administrator is a self-service door, and this host
 * takes automated /admin and formLogin probes continuously - we watched them arrive
 * while building it.
 *
 * There is no login form here. /admin with no session hands the browser to the Hub
 * using the SAME round trip the connector uses, marked with a sentinel so the callback
 * knows to issue an admin session instead of an OAuth code. One authentication path,
 * one place where it can be got wrong.
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import * as hub from './../auth/hub.js';
import * as users from './../auth/users.js';
import { revokeUser } from './../auth/tokens.js';
import * as audit from './../core/audit.js';
import { cfg } from './../core/config.js';
import { logger } from './../core/logger.js';
import { clientIpOf } from './clientIp.js';
import { loginCsp, renderErrorPage } from './../auth/loginPage.js';
import { renderAdminPage } from './../auth/adminPage.js';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  adminCookieOptions,
  readAdminSession,
  type AdminSession,
} from './../auth/adminSession.js';

/** PRD Section 16. Mirrored here so the page can say "n of 15" without a second source. */
const PILOT_CAP = 15;

/** The round-trip marker. A real pending token is a JWT, so it can never be this. */
export const ADMIN_ROUND_TRIP = 'admin-ui';

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status).setHeader('Content-Security-Policy', loginCsp());
  res.type('html').send(html);
}

/** Constant-time compare that cannot throw on a length mismatch. */
function csrfMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export function adminRouter(): Router {
  const router = Router();

  /**
   * Resolve the session, or send the browser to the Hub.
   *
   * Re-reads is_admin from the database on EVERY request rather than trusting the
   * claim in the cookie. A session lives thirty minutes; revoking someone's admin
   * rights must take effect when it is revoked, not when their tab happens to expire.
   */
  async function requireAdmin(req: Request, res: Response): Promise<AdminSession | undefined> {
    const session = await readAdminSession(req.cookies?.[ADMIN_SESSION_COOKIE] as string | undefined);
    if (session === undefined) {
      if (!cfg.hubEnabled) {
        sendHtml(res, 503, renderErrorPage('Sign-in unavailable', 'Downstream Hub sign-in is not configured.'));
        return undefined;
      }
      const trip = await hub.beginRoundTrip(ADMIN_ROUND_TRIP);
      res.redirect(302, await hub.authorizationUrl(trip));
      return undefined;
    }

    const row = await users.findByEmail(session.email);
    if (row === undefined || row.disabled_at !== null || !row.is_admin) {
      logger.warn({ email: session.email }, 'admin session presented by an account that is no longer an admin');
      res.clearCookie(ADMIN_SESSION_COOKIE, adminCookieOptions());
      sendHtml(res, 403, renderErrorPage('Access withdrawn', 'Your administrator access has been removed.'));
      return undefined;
    }
    return session;
  }

  /** Guard a state-changing POST: session, then CSRF. */
  async function requirePost(req: Request, res: Response): Promise<AdminSession | undefined> {
    const session = await requireAdmin(req, res);
    if (session === undefined) return undefined;
    if (!csrfMatches(session.csrf, req.body?.csrf)) {
      logger.warn({ email: session.email }, 'admin POST rejected: CSRF token did not match the session');
      sendHtml(res, 403, renderErrorPage('Request could not be verified', 'Reload the page and try again.'));
      return undefined;
    }
    return session;
  }

  async function page(
    res: Response,
    session: AdminSession,
    opts: { error?: string; notice?: string } = {},
  ): Promise<void> {
    sendHtml(
      res,
      opts.error === undefined ? 200 : 400,
      renderAdminPage({
        signedInAs: session.email,
        csrf: session.csrf,
        pilots: await users.listPilots(),
        pilotCap: PILOT_CAP,
        ...opts,
      }),
    );
  }

  router.get('/admin', async (req: Request, res: Response) => {
    const session = await requireAdmin(req, res);
    if (session === undefined) return;
    await page(res, session);
  });

  router.post('/admin/users', async (req: Request, res: Response) => {
    const session = await requirePost(req, res);
    if (session === undefined) return;

    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    const ctx = { requestId: audit.newRequestId(), userId: session.email, clientIp: clientIpOf(req) };

    // Deliberately strict rather than clever: an address that does not match their Hub
    // account silently never works, and the person is left believing they have access.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      await page(res, session, { error: 'That is not a valid email address.' });
      return;
    }
    if (await users.findByEmail(email)) {
      await page(res, session, { error: `${email} is already on the list.` });
      return;
    }
    const active = (await users.listPilots()).filter((p) => !p.isBreakGlass && !p.disabled).length;
    if (active >= PILOT_CAP) {
      await page(res, session, { error: `The pilot is full at ${PILOT_CAP} places.` });
      return;
    }

    try {
      await users.addHubUser(email, displayName === '' ? undefined : displayName);
      await audit.write({
        event: 'admin_action',
        ctx,
        outcome: 'pilot_user_added',
        detail: { email: email.toLowerCase(), by: session.email, via: 'admin_ui', severity: 'high' },
      });
      await page(res, session, { notice: `${email} added. They can now connect through Downstream Hub.` });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'admin UI could not add a pilot user');
      await page(res, session, { error: `Could not add ${email}: ${(err as Error).message}` });
    }
  });

  for (const action of ['disable', 'enable'] as const) {
    router.post(`/admin/users/${action}`, async (req: Request, res: Response) => {
      const session = await requirePost(req, res);
      if (session === undefined) return;

      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const target = await users.findByEmail(email);
      if (target === undefined) {
        await page(res, session, { error: 'No such account.' });
        return;
      }
      // Locking yourself out is a support call, and the UI is the likeliest place to
      // do it by mis-clicking the row you are reading.
      if (action === 'disable' && target.email.toLowerCase() === session.email.toLowerCase()) {
        await page(res, session, { error: 'You cannot disable your own account from here.' });
        return;
      }
      // The emergency account is reached only from a shell; this page is reached
      // through the Hub, so disabling it here could only be undone the hard way.
      if (target.is_break_glass) {
        await page(res, session, { error: 'The break-glass account is managed from the CLI only.' });
        return;
      }

      try {
        if (action === 'disable') {
          await users.disable(email);
          await revokeUser(target.id, 'pilot access withdrawn from the admin UI');
        } else {
          await users.enable(email);
        }
        await audit.write({
          event: 'admin_action',
          ctx: { requestId: audit.newRequestId(), userId: session.email, clientIp: clientIpOf(req) },
          outcome: action === 'disable' ? 'pilot_user_disabled' : 'pilot_user_enabled',
          detail: { email: target.email, by: session.email, via: 'admin_ui', severity: 'high' },
        });
        await page(res, session, {
          notice:
            action === 'disable'
              ? `${target.email} disabled, and every token they held has been revoked.`
              : `${target.email} enabled. They will need to reconnect.`,
        });
      } catch (err) {
        await page(res, session, { error: (err as Error).message });
      }
    });
  }

  router.post('/admin/logout', async (req: Request, res: Response) => {
    const session = await readAdminSession(req.cookies?.[ADMIN_SESSION_COOKIE] as string | undefined);
    // CSRF on sign-out too. Being logged out by a crafted page is minor, but it is a
    // state change, and carving out exceptions is how the rule stops being a rule.
    if (session !== undefined && !csrfMatches(session.csrf, req.body?.csrf)) {
      sendHtml(res, 403, renderErrorPage('Request could not be verified', 'Reload the page and try again.'));
      return;
    }
    res.clearCookie(ADMIN_SESSION_COOKIE, adminCookieOptions());
    sendHtml(res, 200, renderErrorPage('Signed out', 'You are signed out of the connector admin page.'));
  });

  return router;
}

/** Cookie max-age, exported so the callback that sets it cannot drift from the reader. */
export const ADMIN_COOKIE_MAX_AGE_MS = ADMIN_SESSION_TTL_SECONDS * 1000;

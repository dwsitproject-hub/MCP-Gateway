/**
 * The routes behind /authorize that finish the flow.
 *
 * Two paths lead to the same place - an authorization code redirected back to
 * Claude - and both go through the same pilot allowlist:
 *
 *   PRIMARY   /authorize/hub/start  -> Downstream Hub -> /authorize/hub/callback
 *   BREAK-GLASS /authorize/consent  (local password, IT only)
 *
 * CSRF on the local forms: the unguessable signed pending token plus a nonce that
 * must match the mcp_csrf cookie (double submit). Both are checked before any
 * credential is looked at.
 *
 * The Hub leg does not need that cookie - its protection is the single-use `state`
 * row plus the ID token's `nonce`, which live server-side and never reach the
 * browser.
 */
import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import * as audit from './../core/audit.js';
import { logger } from './../core/logger.js';
import { cfg } from './../core/config.js';
import { createAuthorizationCode, verifyPending, type PendingAuthorization } from './../auth/provider.js';
import { admitHubIdentity, authenticate, setPassword } from './../auth/users.js';
import * as hub from './../auth/hub.js';
import {
  loginCsp,
  renderChangePasswordPage,
  renderErrorPage,
  renderLoginPage,
  renderNotPermittedPage,
} from './../auth/loginPage.js';
import { clientIpOf } from './clientIp.js';

const MIN_PASSWORD_LENGTH = 12;

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function checkCsrf(req: Request, pending: PendingAuthorization): boolean {
  const submitted = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
  const cookie = typeof req.cookies?.mcp_csrf === 'string' ? req.cookies.mcp_csrf : '';
  if (submitted === '' || cookie === '') return false;
  return constantTimeEqual(submitted, pending.csrf) && constantTimeEqual(cookie, pending.csrf);
}

function sendHtml(res: Response, status: number, html: string, formTargets: readonly string[] = []): void {
  // A re-rendered login page carries the same two off-origin buttons as the first
  // render, so it needs the same form-action allowances. Omitting them here would make
  // the buttons work on the first attempt and silently die after a failed password.
  res.status(status).setHeader('Content-Security-Policy', loginCsp(formTargets));
  res.type('html').send(html);
}

async function loadPending(req: Request, res: Response): Promise<PendingAuthorization | undefined> {
  const token = typeof req.body?.pending === 'string' ? req.body.pending : '';
  if (token === '') {
    sendHtml(res, 400, renderErrorPage('Invalid request', 'The authorization request is missing.'));
    return undefined;
  }
  try {
    const pending = await verifyPending(token);
    if (!checkCsrf(req, pending)) {
      sendHtml(
        res,
        403,
        renderErrorPage('Request could not be verified', 'Please restart the connection from the application.'),
      );
      return undefined;
    }
    return pending;
  } catch {
    sendHtml(
      res,
      400,
      renderErrorPage('Authorization request expired', 'Please restart the connection from the application.'),
    );
    return undefined;
  }
}

export function consentRouter(): Router {
  const router = Router();

  // =========================================================================
  // PRIMARY PATH: Downstream Hub OIDC
  // =========================================================================

  /** Hand the browser off to the Hub. */
  router.post('/authorize/hub/start', async (req: Request, res: Response) => {
    if (!cfg.hubEnabled) {
      sendHtml(res, 503, renderErrorPage('Sign-in unavailable', 'Downstream Hub sign-in is not configured.'));
      return;
    }
    const pending = await loadPending(req, res);
    if (pending === undefined) return;

    try {
      const trip = await hub.beginRoundTrip(String(req.body.pending));
      const url = await hub.authorizationUrl(trip);
      logger.info({ clientId: pending.clientId }, 'redirecting to Downstream Hub for authentication');
      res.redirect(302, url);
    } catch (err) {
      const reason = err instanceof hub.HubError ? err.reason : 'unknown';
      logger.error({ reason, err: (err as Error).message }, 'could not start Hub sign-in');
      sendHtml(
        res,
        502,
        renderErrorPage(
          'Sign-in unavailable',
          'Downstream Hub could not be reached. Try again shortly, or contact IT if this persists.',
        ),
      );
    }
  });

  /** The Hub returns here with ?code&state. */
  router.get('/authorize/hub/callback', async (req: Request, res: Response) => {
    const clientIp = clientIpOf(req);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const hubError = typeof req.query.error === 'string' ? req.query.error : undefined;

    if (hubError !== undefined) {
      const description = typeof req.query.error_description === 'string' ? req.query.error_description : hubError;
      await audit
        .write({
          event: 'auth_fail',
          ctx: { requestId: audit.newRequestId(), userId: 'unknown', clientIp },
          outcome: `hub_${hubError}`,
        })
        .catch(() => undefined);
      sendHtml(res, 400, renderErrorPage('Sign-in was not completed', description));
      return;
    }

    /**
     * IdP-initiated sign-in.
     *
     * DWS Hub can send a user straight here from its dashboard tile, generating the
     * PKCE challenge itself and passing the verifier in the query string. For an
     * ordinary web app that is a supported second entry point.
     *
     * It cannot work for a connector, and not because of a missing feature: this
     * flow exists to complete an authorization request that CLAUDE started. Arriving
     * without one means there is no client, no redirect_uri and no code_challenge to
     * issue a code against, so there is nothing to complete. Say so plainly rather
     * than failing as "sign-in expired", which would send people hunting a timeout.
     */
    if (typeof req.query.code_verifier === 'string' && req.query.code_verifier !== '') {
      logger.info('rejected an IdP-initiated Hub sign-in: no Claude authorization request to complete');
      sendHtml(
        res,
        400,
        renderErrorPage(
          'Start from Claude instead',
          'This connector cannot be opened from the Downstream Hub dashboard. Enable the KLIP connector ' +
            'in Claude and authorize it there; Claude will send you through Downstream Hub as part of that.',
        ),
      );
      return;
    }

    if (state === '' || code === '') {
      sendHtml(res, 400, renderErrorPage('Invalid response', 'The sign-in response from Downstream Hub was incomplete.'));
      return;
    }

    // The state row is single-use; a replayed callback dies here.
    let trip: { pendingToken: string; codeVerifier: string; nonce: string };
    try {
      trip = await hub.consumeRoundTrip(state);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Hub callback rejected: state not valid');
      sendHtml(
        res,
        400,
        renderErrorPage('Sign-in expired', 'This sign-in link is no longer valid. Please start again from the application.'),
      );
      return;
    }

    let pending: PendingAuthorization;
    try {
      pending = await verifyPending(trip.pendingToken);
    } catch {
      sendHtml(res, 400, renderErrorPage('Authorization request expired', 'Please restart the connection from the application.'));
      return;
    }

    // Exchange the code and validate the ID token (signature, iss, aud, exp, nonce).
    let identity: hub.HubIdentity;
    try {
      identity = await hub.exchangeCode(code, trip.codeVerifier, trip.nonce);
    } catch (err) {
      const reason = err instanceof hub.HubError ? err.reason : 'unknown';
      await audit
        .write({
          event: 'auth_fail',
          ctx: { requestId: audit.newRequestId(), userId: 'unknown', clientIp },
          outcome: `hub_${reason}`,
        })
        .catch(() => undefined);
      logger.warn({ reason, err: (err as Error).message }, 'Hub sign-in failed validation');
      sendHtml(
        res,
        reason === 'not_permitted' ? 403 : 400,
        renderErrorPage('Sign-in could not be verified', (err as Error).message),
      );
      return;
    }

    // Authentication succeeded; now the AUTHORIZATION decision: is this person on
    // the vetted pilot list? Hub membership alone is not enough (review H8).
    const admission = await admitHubIdentity(identity);
    const ctx = { requestId: audit.newRequestId(), userId: identity.email, clientIp, oauthClientId: pending.clientId };

    if (!admission.ok) {
      await audit.write({ event: 'auth_fail', ctx, outcome: `hub_${admission.reason}` }).catch(() => undefined);
      const message =
        admission.reason === 'not_on_pilot_list'
          ? 'Your Downstream Hub account is not on the KLIP connector pilot list.'
          : admission.reason === 'disabled'
            ? 'This account has been disabled for the KLIP connector.'
            : 'This pilot entry is already bound to a different Downstream Hub account. Contact IT.';
      sendHtml(res, 403, renderNotPermittedPage(identity.email, message));
      return;
    }

    await audit
      .write({
        event: 'auth_login',
        ctx: { ...ctx, userId: admission.user.email },
        outcome: 'ok',
        detail: { auth_source: 'hub', hub_groups: identity.groups.length },
      })
      .catch(() => undefined);

    const { redirectTo } = await createAuthorizationCode(pending, admission.user.id);
    logger.info({ user: admission.user.email, clientId: pending.clientId }, 'authorization code issued (Hub)');
    res.redirect(302, redirectTo);
  });

  // =========================================================================
  // BREAK-GLASS PATH: local password
  // =========================================================================

  router.post('/authorize/consent', async (req: Request, res: Response) => {
    if (!cfg.BREAK_GLASS_ENABLED) {
      sendHtml(
        res,
        403,
        renderErrorPage('Password sign-in disabled', 'This gateway requires Downstream Hub sign-in.'),
      );
      return;
    }

    const pending = await loadPending(req, res);
    if (pending === undefined) return;

    const pendingToken = String(req.body.pending);
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const clientIp = clientIpOf(req);
    const ctx = { requestId: audit.newRequestId(), userId: email || 'unknown', clientIp, oauthClientId: pending.clientId };

    const relogin = (status: number, message: string): void => {
      sendHtml(res, status, renderLoginPage({
        pendingToken,
        csrfToken: pending.csrf,
        clientName: pending.clientName,
        error: message,
        email,
        hubEnabled: cfg.hubEnabled,
        breakGlassEnabled: cfg.BREAK_GLASS_ENABLED,
      }), [pending.redirectUri, cfg.HUB_ISSUER ?? '']);
    };

    if (email === '' || password === '') {
      relogin(400, 'Enter your email and password.');
      return;
    }

    const result = await authenticate(email, password);

    if (!result.ok) {
      await audit.write({ event: 'auth_fail', ctx, outcome: result.reason }).catch(() => undefined);
      const message =
        result.reason === 'locked'
          ? `Too many failed attempts. Try again in ${result.retryAfterMinutes ?? 15} minutes.`
          : result.reason === 'disabled'
            ? 'This account is disabled. Contact IT.'
            : result.reason === 'not_local'
              ? 'This account signs in through Downstream Hub. Use the button above.'
              : 'Email or password is incorrect.';
      relogin(401, message);
      return;
    }

    if (result.user.mustChangePassword) {
      sendHtml(res, 200, renderChangePasswordPage({ pendingToken, csrfToken: pending.csrf, email: result.user.email }), [pending.redirectUri]);
      return;
    }

    // A break-glass sign-in is an exception worth flagging in the audit trail.
    await audit
      .write({
        event: 'auth_login',
        ctx: { ...ctx, userId: result.user.email },
        outcome: 'ok',
        detail: { auth_source: 'local', break_glass: true, severity: 'high' },
      })
      .catch(() => undefined);
    logger.warn({ user: result.user.email }, 'BREAK-GLASS password sign-in used');

    const { redirectTo } = await createAuthorizationCode(pending, result.user.id);
    res.redirect(302, redirectTo);
  });

  router.post('/authorize/change-password', async (req: Request, res: Response) => {
    if (!cfg.BREAK_GLASS_ENABLED) {
      sendHtml(res, 403, renderErrorPage('Password sign-in disabled', 'This gateway requires Downstream Hub sign-in.'));
      return;
    }

    const pending = await loadPending(req, res);
    if (pending === undefined) return;

    const pendingToken = String(req.body.pending);
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const current = typeof req.body.current === 'string' ? req.body.current : '';
    const next = typeof req.body.next === 'string' ? req.body.next : '';
    const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
    const clientIp = clientIpOf(req);

    const fail = (message: string): void => {
      sendHtml(res, 400, renderChangePasswordPage({ pendingToken, csrfToken: pending.csrf, email, error: message }));
    };

    if (next.length < MIN_PASSWORD_LENGTH) return fail(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (next !== confirm) return fail('The two new passwords do not match.');
    if (next === current) return fail('The new password must differ from the current one.');

    const verified = await authenticate(email, current);
    if (!verified.ok) {
      await audit
        .write({
          event: 'auth_fail',
          ctx: { requestId: audit.newRequestId(), userId: email, clientIp, oauthClientId: pending.clientId },
          outcome: 'change_password_bad_current',
        })
        .catch(() => undefined);
      return fail('Current password is incorrect.');
    }

    await setPassword(email, next);
    await audit
      .write({
        event: 'admin_action',
        ctx: { requestId: audit.newRequestId(), userId: verified.user.email, clientIp },
        outcome: 'break_glass_password_changed',
      })
      .catch(() => undefined);

    const { redirectTo } = await createAuthorizationCode(pending, verified.user.id);
    logger.warn({ user: verified.user.email }, 'break-glass password changed and authorization code issued');
    res.redirect(302, redirectTo);
    return;
  });

  return router;
}

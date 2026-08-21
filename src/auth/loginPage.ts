/**
 * Login and consent pages (TSD Section 8.1, reworked for Hub OIDC per review H2).
 *
 * Deliberately minimal and self-contained: no external stylesheet, no script, no
 * third-party asset, and a tight CSP. That matters most here, because this is the
 * only surface that ever handles a password.
 *
 * The Hub button is the primary action. The break-glass password form is behind a
 * <details> disclosure so it reads as the exception it is - a pilot user who is
 * shown a password box on a public host is being trained into a phishable habit.
 */
import { klipTools } from './../tools/klip/index.js';
import { cfg } from './../core/config.js';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const LOGIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background:#f4f5f7; color:#1c1e21; padding:24px; }
  @media (prefers-color-scheme: dark) { body { background:#16181c; color:#e6e8eb; } }
  .card { width:100%; max-width:460px; background:#fff; border-radius:12px; padding:28px;
          box-shadow:0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { .card { background:#21242a; box-shadow:none; border:1px solid #33373f; } }
  h1 { font-size:19px; margin:0 0 4px; }
  .sub { font-size:13px; opacity:.7; margin:0 0 20px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 5px; }
  input { width:100%; padding:10px 12px; font-size:15px; border:1px solid #c9ccd1; border-radius:7px;
          background:#fff; color:inherit; }
  @media (prefers-color-scheme: dark) { input { background:#1a1c21; border-color:#3d424b; } }
  button { width:100%; margin-top:20px; padding:11px; font-size:15px; font-weight:600; border:0;
           border-radius:7px; background:#1a6ef5; color:#fff; cursor:pointer; }
  button:hover { background:#1560db; }
  button.secondary { background:#6b7280; }
  button.secondary:hover { background:#5b6270; }
  .scope { margin:18px 0 0; padding:14px 16px; background:#f0f6ff; border-left:3px solid #1a6ef5;
           border-radius:6px; font-size:13px; }
  @media (prefers-color-scheme: dark) { .scope { background:#182233; } }
  .scope ul { margin:8px 0 0; padding-left:18px; }
  .scope code { font-size:12px; }
  .err { margin:0 0 16px; padding:11px 14px; background:#fdecec; border-left:3px solid #d93025;
         border-radius:6px; font-size:13px; color:#8b1a12; }
  @media (prefers-color-scheme: dark) { .err { background:#2e1917; color:#f3b3ad; } }
  .env { display:inline-block; margin-bottom:12px; padding:2px 9px; border-radius:99px; font-size:11px;
         font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
  .env.staging { background:#fff3cd; color:#7a5b00; }
  .env.production { background:#e3f5e9; color:#14652f; }
  .foot { margin-top:18px; font-size:12px; opacity:.65; }
  details { margin-top:22px; border-top:1px solid #e3e5e8; padding-top:14px; }
  @media (prefers-color-scheme: dark) { details { border-color:#33373f; } }
  summary { font-size:13px; opacity:.7; cursor:pointer; }
  .warn { margin:12px 0 0; padding:10px 13px; background:#fff8e1; border-left:3px solid #f0a000;
          border-radius:6px; font-size:12.5px; color:#6b4c00; }
  @media (prefers-color-scheme: dark) { .warn { background:#2b2313; color:#f2d089; } }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body><div class="card">${body}</div></body></html>`;
}

function scopeBlock(): string {
  const toolList = klipTools
    .map((t) => `<li><code>${escapeHtml(t.name)}</code> &mdash; ${escapeHtml(t.title)}</li>`)
    .join('');
  return `<div class="scope">
      <strong>This grants read-only access.</strong> The connector can run these queries and nothing else.
      It cannot create, change, approve or delete anything in KLIP.
      <ul>${toolList}</ul>
    </div>`;
}

export interface LoginPageOptions {
  /** Signed, short-lived token carrying the pending authorization request. */
  pendingToken: string;
  csrfToken: string;
  clientName: string;
  error?: string | undefined;
  email?: string | undefined;
  /** Show the Hub button as the primary action. */
  hubEnabled: boolean;
  /** Show the break-glass password disclosure. */
  breakGlassEnabled: boolean;
}

export function renderLoginPage(opts: LoginPageOptions): string {
  const hidden = `
    <input type="hidden" name="pending" value="${escapeHtml(opts.pendingToken)}">
    <input type="hidden" name="csrf" value="${escapeHtml(opts.csrfToken)}">`;

  const hubForm = opts.hubEnabled
    ? `<form method="post" action="/authorize/hub/start">${hidden}
         <button type="submit">Continue with Downstream Hub</button>
       </form>`
    : '';

  const breakGlassForm = opts.breakGlassEnabled
    ? `<details${opts.hubEnabled ? '' : ' open'}>
         <summary>${opts.hubEnabled ? 'Break-glass sign-in (IT only)' : 'Sign in with a gateway account'}</summary>
         ${
           opts.hubEnabled
             ? `<p class="warn">Use this only when Downstream Hub is unavailable. Break-glass sign-ins are
                audited and reviewed.</p>`
             : ''
         }
         <form method="post" action="/authorize/consent" autocomplete="on">${hidden}
           <label for="email">Work email</label>
           <input id="email" name="email" type="email" required autocomplete="username"
                  value="${escapeHtml(opts.email ?? '')}">
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required autocomplete="current-password">
           <button type="submit" class="${opts.hubEnabled ? 'secondary' : ''}">Sign in and approve</button>
         </form>
       </details>`
    : '';

  const body = `
  <span class="env ${escapeHtml(cfg.KLIP_ENV)}">KLIP ${escapeHtml(cfg.KLIP_ENV)}</span>
  <h1>Authorize ${escapeHtml(opts.clientName)}</h1>
  <p class="sub">Sign in to let this application read KLIP data on your behalf.</p>
  ${opts.error === undefined ? '' : `<p class="err">${escapeHtml(opts.error)}</p>`}
  ${hubForm}
  ${scopeBlock()}
  ${breakGlassForm}
  <p class="foot">Answers carry an "as of" timestamp. Verify critical figures in KLIP itself.</p>`;

  return shell('Authorize connector', body);
}

export interface ChangePasswordOptions {
  pendingToken: string;
  csrfToken: string;
  email: string;
  error?: string | undefined;
}

export function renderChangePasswordPage(opts: ChangePasswordOptions): string {
  const body = `
  <h1>Choose a new password</h1>
  <p class="sub">This break-glass account requires a password change before use.</p>
  ${opts.error === undefined ? '' : `<p class="err">${escapeHtml(opts.error)}</p>`}
  <form method="post" action="/authorize/change-password" autocomplete="on">
    <input type="hidden" name="pending" value="${escapeHtml(opts.pendingToken)}">
    <input type="hidden" name="csrf" value="${escapeHtml(opts.csrfToken)}">
    <input type="hidden" name="email" value="${escapeHtml(opts.email)}">
    <label for="current">Current password</label>
    <input id="current" name="current" type="password" required autocomplete="current-password">
    <label for="next">New password (at least 12 characters)</label>
    <input id="next" name="next" type="password" required minlength="12" autocomplete="new-password">
    <label for="confirm">Confirm new password</label>
    <input id="confirm" name="confirm" type="password" required minlength="12" autocomplete="new-password">
    <button type="submit">Set password and continue</button>
  </form>`;

  return shell('Change password', body);
}

export function renderErrorPage(title: string, message: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p class="err">${escapeHtml(message)}</p>`);
}

/** Shown when the Hub authenticated someone who is not on the pilot list. */
export function renderNotPermittedPage(email: string, reason: string): string {
  return shell(
    'Access not granted',
    `<h1>Access not granted</h1>
     <p class="err">${escapeHtml(reason)}</p>
     <p class="sub">Signed in at Downstream Hub as ${escapeHtml(email)}.</p>
     <p class="foot">The KLIP connector is limited to a vetted pilot group. Ask IT to add your account
     if you need access.</p>`,
  );
}

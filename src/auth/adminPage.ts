/**
 * The pilot-list admin page.
 *
 * Server-rendered, no JavaScript, no external assets. The CSP on this route is
 * `default-src 'none'` with inline styles only, which a page with a script tag or a
 * CDN font could not satisfy - and a page that grants access to production commercial
 * data is the last place to start loading third-party code.
 *
 * Every mutation is a POST with the session's CSRF token in a hidden field. No links
 * change state, so a crafted <img src> or a mistyped URL cannot add anybody.
 */
import { escapeHtml } from './loginPage.js';
import type { PilotRow } from './users.js';
import type { RankedGap } from './../core/gaps.js';
import { cfg } from './../core/config.js';

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
         Roboto, sans-serif; background:#f4f5f7; color:#1c1e21; padding:32px 24px; }
  @media (prefers-color-scheme: dark) { body { background:#16181c; color:#e6e8eb; } }
  .wrap { max-width:860px; margin:0 auto; }
  .card { background:#fff; border-radius:12px; padding:24px 26px; margin-bottom:20px;
          box-shadow:0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { .card { background:#21242a; box-shadow:none; border:1px solid #33373f; } }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 14px; }
  .sub { font-size:13px; opacity:.7; margin:0 0 18px; }
  .env { display:inline-block; padding:2px 9px; border-radius:99px; font-size:11px; font-weight:700;
         text-transform:uppercase; letter-spacing:.04em; margin-left:8px; vertical-align:2px; }
  .env.staging { background:#fff3cd; color:#7a5b00; }
  .env.production { background:#e3f5e9; color:#14652f; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; opacity:.6;
       padding:0 10px 8px 0; font-weight:700; }
  td { padding:9px 10px 9px 0; border-top:1px solid #e9eaec; vertical-align:middle; }
  @media (prefers-color-scheme: dark) { td { border-color:#31353c; } }
  .tag { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px; font-weight:600; }
  .tag.hub { background:#e8eefc; color:#1a4ba8; }
  .tag.local { background:#fdeaea; color:#9a2620; }
  .tag.admin { background:#efe6fb; color:#5a2ca0; }
  .tag.off { background:#eceef0; color:#5a6069; }
  .tag.on { background:#e3f5e9; color:#14652f; }
  @media (prefers-color-scheme: dark) {
    .tag.hub { background:#1a2540; color:#9dbaf0; } .tag.local { background:#331b19; color:#f0a9a3; }
    .tag.admin { background:#271b3a; color:#c4a6ef; } .tag.off { background:#2a2e34; color:#9aa2ad; }
    .tag.on { background:#16301f; color:#8fd6a8; }
  }
  form.row { display:inline; }
  label { display:block; font-size:13px; font-weight:600; margin:0 0 5px; }
  input[type=email], input[type=text] { width:100%; padding:10px 12px; font-size:15px;
        border:1px solid #c9ccd1; border-radius:7px; background:#fff; color:inherit; }
  @media (prefers-color-scheme: dark) { input { background:#1a1c21; border-color:#3d424b; } }
  .fields { display:flex; gap:12px; flex-wrap:wrap; }
  .fields > div { flex:1 1 240px; }
  button { padding:10px 16px; font-size:14px; font-weight:600; border:0; border-radius:7px;
           background:#1a6ef5; color:#fff; cursor:pointer; }
  button:hover { background:#1560db; }
  button.small { padding:5px 11px; font-size:12.5px; font-weight:600; background:#6b7280; }
  button.small:hover { background:#5b6270; }
  button.danger { background:#b3261e; } button.danger:hover { background:#98201a; }
  .actions { margin-top:16px; }
  .err { margin:0 0 16px; padding:11px 14px; background:#fdecec; border-left:3px solid #d93025;
         border-radius:6px; font-size:13px; color:#8b1a12; }
  @media (prefers-color-scheme: dark) { .err { background:#2e1917; color:#f3b3ad; } }
  .ok { margin:0 0 16px; padding:11px 14px; background:#e7f6ec; border-left:3px solid #1e8e3e;
        border-radius:6px; font-size:13px; color:#11602c; }
  @media (prefers-color-scheme: dark) { .ok { background:#14281b; color:#9ad9ae; } }
  .warn { margin:16px 0 0; padding:11px 14px; background:#fff8e1; border-left:3px solid #f0a000;
          border-radius:6px; font-size:12.5px; color:#6b4c00; }
  @media (prefers-color-scheme: dark) { .warn { background:#2b2313; color:#f2d089; } }
  .foot { font-size:12px; opacity:.6; margin-top:6px; }
  .bar { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:18px; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

export interface AdminPageOptions {
  /** What the connector was asked for and could not answer, most asked first. */
  gaps: RankedGap[];
  signedInAs: string;
  csrf: string;
  pilots: PilotRow[];
  error?: string | undefined;
  notice?: string | undefined;
  /** PRD Section 16 caps the pilot at 15 Hub accounts. */
  pilotCap: number;
}

function hidden(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function row(p: PilotRow, csrf: string, signedInAs: string): string {
  const self = p.email.toLowerCase() === signedInAs.toLowerCase();
  const source = p.isBreakGlass
    ? '<span class="tag local">break-glass</span>'
    : `<span class="tag ${p.authSource === 'hub' ? 'hub' : 'local'}">${escapeHtml(p.authSource)}</span>`;
  const admin = p.isAdmin ? '<span class="tag admin">admin</span>' : '';
  const state = p.disabled ? '<span class="tag off">disabled</span>' : '<span class="tag on">active</span>';
  const linked = p.isBreakGlass ? '&ndash;' : p.hubLinked ? 'linked' : 'not yet';

  // The break-glass account is not editable here at all. It is the way back in when
  // the Hub is down, and this page is reached THROUGH the Hub - so a mis-click that
  // disabled it could only be undone from a shell.
  const controls = p.isBreakGlass
    ? '<span class="foot">managed from the CLI</span>'
    : `<form class="row" method="post" action="/admin/users/${p.disabled ? 'enable' : 'disable'}">
         ${hidden(csrf)}<input type="hidden" name="email" value="${escapeHtml(p.email)}">
         <button class="small ${p.disabled ? '' : 'danger'}"${self && !p.disabled ? ' disabled title="You cannot disable your own account"' : ''}>${p.disabled ? 'Enable' : 'Disable'}</button>
       </form>`;

  return `<tr>
    <td><strong>${escapeHtml(p.email)}</strong>${self ? ' <span class="foot">(you)</span>' : ''}<br>
        <span class="foot">${escapeHtml(p.displayName ?? '')}</span></td>
    <td>${source} ${admin}</td>
    <td>${state}</td>
    <td>${linked}</td>
    <td>${controls}</td>
  </tr>`;
}

/** One gap, with up to three of the questions that produced it. */
function gapRow(g: RankedGap, csrf: string): string {
  const when = (d: Date | string): string => String(d).slice(0, 10);
  // The questions are the point of the panel. A topic slug says someone wanted
  // something about tanks; the question says what they were trying to decide.
  const questions =
    g.questions.length === 0
      ? ''
      : `<br>${g.questions
          .map((q) => `<span class="foot">&ldquo;${escapeHtml(q)}&rdquo;</span>`)
          .join('<br>')}`;
  return `<tr>
    <td><strong>${escapeHtml(g.slug)}</strong>${questions}</td>
    <td>${String(g.times_asked)}</td>
    <td>${escapeHtml(when(g.last_seen))}</td>
    <td>${g.systems.map((s) => `<span class="tag hub">${escapeHtml(s)}</span>`).join(' ')}</td>
    <td><form class="row" method="post" action="/admin/gaps/resolve">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="slug" value="${escapeHtml(g.slug)}">
      <button class="small">Resolve</button>
    </form></td>
  </tr>`;
}

export function renderAdminPage(opts: AdminPageOptions): string {
  const hubUsers = opts.pilots.filter((p) => !p.isBreakGlass && !p.disabled).length;
  const atCap = hubUsers >= opts.pilotCap;

  const body = `
    <div class="card">
      <div class="bar">
        <div>
          <h1>KLIP connector pilot list<span class="env ${escapeHtml(cfg.KLIP_ENV)}">${escapeHtml(cfg.KLIP_ENV)}</span></h1>
          <p class="sub">Signed in as ${escapeHtml(opts.signedInAs)}.
             ${hubUsers} of ${opts.pilotCap} pilot places used.</p>
        </div>
        <form method="post" action="/admin/logout">${hidden(opts.csrf)}<button class="small">Sign out</button></form>
      </div>
      ${opts.error !== undefined ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
      ${opts.notice !== undefined ? `<p class="ok">${escapeHtml(opts.notice)}</p>` : ''}
      <table>
        <thead><tr><th>Account</th><th>Sign-in</th><th>State</th><th>Hub linked</th><th></th></tr></thead>
        <tbody>${opts.pilots.map((p) => row(p, opts.csrf, opts.signedInAs)).join('')}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>What the connector could not answer</h2>
      <p class="sub">Recorded automatically when a tool reports it cannot reach something, or when a
         knowledge search finds nothing. Most asked first. This is the list to build from.</p>
      ${
        opts.gaps.length === 0
          ? '<p class="foot">Nothing logged yet. Entries appear here as people hit limits.</p>'
          : `<table>
              <thead><tr><th>Topic</th><th>Asked</th><th>Last</th><th>Where</th><th></th></tr></thead>
              <tbody>${opts.gaps.map((g) => gapRow(g, opts.csrf)).join('')}</tbody>
            </table>`
      }
      <p class="warn"><strong>Question text is stored.</strong> It is what makes a gap actionable - a count
         with no wording cannot be built from. It is deleted when you resolve the gap, and after 90 days
         either way. Resolving keeps the count and drops the questions.</p>
    </div>

    <div class="card">
      <h2>Add someone to the pilot</h2>
      <p class="sub">They sign in with Downstream Hub; no password is created here. The address must be
         the one their Hub account uses, because that is what the connector matches on.</p>
      ${
        atCap
          ? `<p class="err">The pilot is full at ${opts.pilotCap} places (PRD Section 16). Disable an account
             before adding another.</p>`
          : `<form method="post" action="/admin/users">
              ${hidden(opts.csrf)}
              <div class="fields">
                <div><label for="email">Downstream Hub email</label>
                     <input id="email" type="email" name="email" required autocomplete="off"
                            placeholder="name@energi-up.com"></div>
                <div><label for="name">Display name <span class="foot">(optional)</span></label>
                     <input id="name" type="text" name="display_name" autocomplete="off"></div>
              </div>
              <div class="actions"><button>Add to pilot</button></div>
            </form>`
      }
      <p class="warn"><strong>This grants read access to ${escapeHtml(cfg.KLIP_ENV)} KLIP data.</strong>
         Phase 1 uses one shared service account, so everyone admitted can read everything the connector
         can read &mdash; there is no per-user narrowing behind this list.</p>
    </div>`;

  return shell('KLIP connector admin', body);
}

/** Shown to someone the Hub authenticated who is not an administrator. */
export function renderNotAdminPage(email: string): string {
  return shell(
    'Not an administrator',
    `<div class="card">
       <h1>Not an administrator</h1>
       <p class="err">Your account is not permitted to manage the KLIP connector pilot list.</p>
       <p class="sub">Signed in at Downstream Hub as ${escapeHtml(email)}.</p>
       <p class="foot">Being on the pilot list lets you USE the connector. Changing who else may use it is
          a separate right, granted from the host by IT.</p>
     </div>`,
  );
}
